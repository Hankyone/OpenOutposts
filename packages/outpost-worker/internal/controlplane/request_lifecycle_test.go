package controlplane

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/config"
	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/protocol"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type cancellingExecutor struct {
	calls   atomic.Int32
	started chan struct{}
}

func (e *cancellingExecutor) Execute(
	ctx context.Context,
	_ string,
	_ string,
	_ json.RawMessage,
) (any, error) {
	e.calls.Add(1)
	select {
	case e.started <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

func lifecycleClient(serverURL, workspace string, executor toolExecutor) *Client {
	client := New(config.Config{
		ControlPlaneURL: serverURL,
		ID:              "workstation-01",
		Name:            "Test workstation",
		Token:           "secret-token",
		Platform:        "linux",
		Architecture:    "amd64",
		WorkspaceRoots:  []string{workspace},
	}, "0.1.0-test", slog.New(slog.NewTextHandler(io.Discard, nil)))
	client.executor = executor
	return client
}

func registerTestWorker(ctx context.Context, ws *websocket.Conn, connectionID string) error {
	var registration protocol.Registration
	if err := wsjson.Read(ctx, ws, &registration); err != nil {
		return err
	}
	return wsjson.Write(ctx, ws, protocol.ServerMessage{
		Type:                "outpost.registered",
		ProtocolVersion:     protocol.Version,
		OutpostID:           registration.OutpostID,
		ConnectionID:        connectionID,
		RegisteredAt:        time.Now().UTC(),
		HeartbeatIntervalMS: 60_000,
	})
}

func offerTestLease(ctx context.Context, ws *websocket.Conn, workspace string) error {
	if err := wsjson.Write(ctx, ws, protocol.ServerMessage{
		Type:             "lease.offer",
		ProtocolVersion:  protocol.Version,
		LeaseID:          "lease-01",
		ProductSessionID: "session-01",
		WorkspacePath:    workspace,
		ExpiresAt:        time.Now().Add(time.Hour).UTC(),
	}); err != nil {
		return err
	}
	var accepted protocol.LeaseAccepted
	return wsjson.Read(ctx, ws, &accepted)
}

func testToolRequest(requestID string) protocol.ServerMessage {
	return protocol.ServerMessage{
		Type:            "tool.request",
		ProtocolVersion: protocol.Version,
		RequestID:       requestID,
		LeaseID:         "lease-01",
		Operation:       "bash",
		Input:           json.RawMessage(`{"command":"sleep 600"}`),
	}
}

func TestQueuedThenStoppedRequestNeverExecutes(t *testing.T) {
	workspace := t.TempDir()
	executor := &cancellingExecutor{started: make(chan struct{}, 1)}
	serverErrors := make(chan error, 1)
	results := make(chan []protocol.ToolResult, 1)

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		ws, err := websocket.Accept(writer, request, nil)
		if err != nil {
			serverErrors <- err
			return
		}
		defer ws.CloseNow()
		ctx := request.Context()

		if err := registerTestWorker(ctx, ws, "connection-01"); err != nil {
			serverErrors <- err
			return
		}
		if err := offerTestLease(ctx, ws, workspace); err != nil {
			serverErrors <- err
			return
		}
		if err := wsjson.Write(ctx, ws, testToolRequest("request-running")); err != nil {
			serverErrors <- err
			return
		}
		select {
		case <-executor.started:
		case <-time.After(2 * time.Second):
			serverErrors <- &testError{"first request did not start"}
			return
		}
		if err := wsjson.Write(ctx, ws, testToolRequest("request-queued")); err != nil {
			serverErrors <- err
			return
		}
		if err := wsjson.Write(ctx, ws, protocol.ServerMessage{
			Type:            "tool.cancel",
			ProtocolVersion: protocol.Version,
			LeaseID:         "lease-01",
		}); err != nil {
			serverErrors <- err
			return
		}

		received := make([]protocol.ToolResult, 0, 2)
		for len(received) < 2 {
			var result protocol.ToolResult
			if err := wsjson.Read(ctx, ws, &result); err != nil {
				serverErrors <- err
				return
			}
			received = append(received, result)
		}
		results <- received
	}))
	defer server.Close()

	client := lifecycleClient(server.URL, workspace, executor)
	client.toolSlots = make(chan struct{}, 1)
	ctx, cancel := context.WithCancel(context.Background())
	clientDone := make(chan error, 1)
	go func() {
		clientDone <- client.connectAndServe(ctx)
	}()

	select {
	case err := <-serverErrors:
		cancel()
		t.Fatal(err)
	case received := <-results:
		if executor.calls.Load() != 1 {
			t.Fatalf("queued request executed: got %d executor calls, want 1", executor.calls.Load())
		}
		for _, result := range received {
			if result.OK || result.ErrorCode != protocol.ErrCancelled {
				t.Fatalf("expected cancelled result, got %+v", result)
			}
		}
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("timed out waiting for cancelled tool results")
	}

	cancel()
	select {
	case <-clientDone:
	case <-time.After(time.Second):
		t.Fatal("client did not stop after cancellation")
	}
}

func TestReconnectDoesNotExecuteRetriedRequestTwice(t *testing.T) {
	workspace := t.TempDir()
	executor := &cancellingExecutor{started: make(chan struct{}, 1)}
	serverErrors := make(chan error, 2)
	secondResult := make(chan protocol.ToolResult, 1)
	var connections atomic.Int32

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection := connections.Add(1)
		ws, err := websocket.Accept(writer, request, nil)
		if err != nil {
			serverErrors <- err
			return
		}
		defer ws.CloseNow()
		ctx := request.Context()

		if err := registerTestWorker(ctx, ws, "connection-"+time.Now().Format("150405.000000")); err != nil {
			serverErrors <- err
			return
		}
		if err := offerTestLease(ctx, ws, workspace); err != nil {
			serverErrors <- err
			return
		}
		if err := wsjson.Write(ctx, ws, testToolRequest("request-retried")); err != nil {
			serverErrors <- err
			return
		}

		if connection == 1 {
			select {
			case <-executor.started:
			case <-time.After(2 * time.Second):
				serverErrors <- &testError{"first request did not start"}
			}
			return
		}

		var result protocol.ToolResult
		if err := wsjson.Read(ctx, ws, &result); err != nil {
			serverErrors <- err
			return
		}
		secondResult <- result
	}))
	defer server.Close()

	client := lifecycleClient(server.URL, workspace, executor)

	firstCtx, cancelFirst := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelFirst()
	if err := client.connectAndServe(firstCtx); err == nil {
		t.Fatal("first connection unexpectedly stayed open")
	}

	secondCtx, cancelSecond := context.WithCancel(context.Background())
	secondDone := make(chan error, 1)
	go func() {
		secondDone <- client.connectAndServe(secondCtx)
	}()

	select {
	case err := <-serverErrors:
		cancelSecond()
		t.Fatal(err)
	case result := <-secondResult:
		if result.RequestID != "request-retried" || result.ErrorCode != protocol.ErrCancelled {
			t.Fatalf("unexpected deduplicated result: %+v", result)
		}
		if executor.calls.Load() != 1 {
			t.Fatalf("retried request executed %d times, want 1", executor.calls.Load())
		}
	case <-time.After(5 * time.Second):
		cancelSecond()
		t.Fatal("timed out waiting for deduplicated retry result")
	}

	cancelSecond()
	select {
	case <-secondDone:
	case <-time.After(time.Second):
		t.Fatal("second connection did not stop after cancellation")
	}
}
