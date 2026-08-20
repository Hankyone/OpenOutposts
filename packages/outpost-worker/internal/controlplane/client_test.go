package controlplane

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/config"
	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/lease"
	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/protocol"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestConnectAndServeRegistersAndHeartbeats(t *testing.T) {
	t.Parallel()

	serverErrors := make(chan error, 1)
	heartbeatReceived := make(chan protocol.Heartbeat, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/outposts/workstation-01/connect" {
			serverErrors <- &testError{"unexpected path: " + request.URL.Path}
			return
		}
		if request.Header.Get("Authorization") != "Bearer secret-token" {
			serverErrors <- &testError{"missing enrollment token"}
			return
		}

		ws, err := websocket.Accept(writer, request, nil)
		if err != nil {
			serverErrors <- err
			return
		}
		defer ws.CloseNow()

		var registration protocol.Registration
		if err := wsjson.Read(request.Context(), ws, &registration); err != nil {
			serverErrors <- err
			return
		}
		if registration.OutpostID != "workstation-01" || registration.Name != "Test workstation" || registration.ProtocolVersion != protocol.Version {
			serverErrors <- &testError{"invalid registration"}
			return
		}
		if err := wsjson.Write(request.Context(), ws, protocol.ServerMessage{
			Type:                "outpost.registered",
			ProtocolVersion:     protocol.Version,
			OutpostID:           registration.OutpostID,
			ConnectionID:        "connection-01",
			RegisteredAt:        time.Now().UTC(),
			HeartbeatIntervalMS: 10,
		}); err != nil {
			serverErrors <- err
			return
		}

		var heartbeat protocol.Heartbeat
		if err := wsjson.Read(request.Context(), ws, &heartbeat); err != nil {
			serverErrors <- err
			return
		}
		heartbeatReceived <- heartbeat
		_ = wsjson.Write(request.Context(), ws, protocol.ServerMessage{
			Type:            "outpost.heartbeat_ack",
			ProtocolVersion: protocol.Version,
			OutpostID:       registration.OutpostID,
			ReceivedAt:      time.Now().UTC(),
		})
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	client := New(config.Config{
		ControlPlaneURL: server.URL,
		ID:              "workstation-01",
		Name:            "Test workstation",
		Token:           "secret-token",
		Platform:        "linux",
		Architecture:    "amd64",
		WorkspaceRoots:  []string{"/workspace"},
	}, "0.1.0-test", slog.New(slog.NewTextHandler(io.Discard, nil)))

	clientDone := make(chan error, 1)
	go func() {
		clientDone <- client.connectAndServe(ctx)
	}()

	select {
	case err := <-serverErrors:
		cancel()
		t.Fatal(err)
	case heartbeat := <-heartbeatReceived:
		if heartbeat.OutpostID != "workstation-01" || heartbeat.ProtocolVersion != protocol.Version {
			cancel()
			t.Fatalf("invalid heartbeat: %+v", heartbeat)
		}
	case <-time.After(2 * time.Second):
		cancel()
		t.Fatal("timed out waiting for heartbeat")
	}

	cancel()
	select {
	case <-clientDone:
	case <-time.After(time.Second):
		t.Fatal("client did not stop after cancellation")
	}
}

func TestConnectAndServeRejectsIncompatibleProtocol(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		ws, err := websocket.Accept(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer ws.CloseNow()

		var registration protocol.Registration
		if err := wsjson.Read(request.Context(), ws, &registration); err != nil {
			t.Error(err)
			return
		}
		if err := wsjson.Write(request.Context(), ws, protocol.ServerMessage{
			Type:                "outpost.registered",
			ProtocolVersion:     protocol.Version - 1,
			OutpostID:           registration.OutpostID,
			ConnectionID:        "connection-old",
			RegisteredAt:        time.Now().UTC(),
			HeartbeatIntervalMS: 15_000,
		}); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()

	client := New(config.Config{
		ControlPlaneURL: server.URL,
		ID:              "workstation-01",
		Name:            "Test workstation",
		Token:           "secret-token",
		Platform:        "linux",
		Architecture:    "amd64",
		WorkspaceRoots:  []string{"/workspace"},
	}, "0.1.0-test", slog.New(slog.NewTextHandler(io.Discard, nil)))

	err := client.connectAndServe(context.Background())
	if err == nil || !strings.Contains(err.Error(), "this worker speaks") {
		t.Fatalf("expected protocol mismatch, got %v", err)
	}
}

func TestLeaseAndToolExecution(t *testing.T) {
	t.Parallel()

	workspace := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(workspace, "AGENTS.md"),
		[]byte("# Workspace instructions"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	serverErrors := make(chan error, 4)
	toolResult := make(chan protocol.ToolResult, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		ws, err := websocket.Accept(writer, request, nil)
		if err != nil {
			serverErrors <- err
			return
		}
		defer ws.CloseNow()
		ctx := request.Context()

		var registration protocol.Registration
		if err := wsjson.Read(ctx, ws, &registration); err != nil {
			serverErrors <- err
			return
		}
		if err := wsjson.Write(ctx, ws, protocol.ServerMessage{
			Type:                "outpost.registered",
			ProtocolVersion:     protocol.Version,
			OutpostID:           registration.OutpostID,
			ConnectionID:        "connection-01",
			RegisteredAt:        time.Now().UTC(),
			HeartbeatIntervalMS: 60_000,
		}); err != nil {
			serverErrors <- err
			return
		}

		if err := wsjson.Write(ctx, ws, protocol.ServerMessage{
			Type:             "lease.offer",
			ProtocolVersion:  protocol.Version,
			LeaseID:          "lease-01",
			ProductSessionID: "session-01",
			WorkspacePath:    workspace,
			ExpiresAt:        time.Now().Add(time.Hour).UTC(),
		}); err != nil {
			serverErrors <- err
			return
		}

		var accepted protocol.LeaseAccepted
		if err := wsjson.Read(ctx, ws, &accepted); err != nil {
			serverErrors <- err
			return
		}
		if accepted.Type != "lease.accepted" || accepted.LeaseID != "lease-01" {
			serverErrors <- &testError{"expected lease acceptance, got " + accepted.Type}
			return
		}

		if err := wsjson.Write(ctx, ws, protocol.ServerMessage{
			Type:            "context.request",
			ProtocolVersion: protocol.Version,
			RequestID:       "context-01",
			LeaseID:         "lease-01",
		}); err != nil {
			serverErrors <- err
			return
		}
		var contextResult protocol.ContextResult
		if err := wsjson.Read(ctx, ws, &contextResult); err != nil {
			serverErrors <- err
			return
		}
		if !contextResult.OK ||
			len(contextResult.Files) != 1 ||
			contextResult.Files[0].Path != "outpost:/AGENTS.md" ||
			contextResult.Files[0].Content != "# Workspace instructions" {
			serverErrors <- &testError{"unexpected context result"}
			return
		}

		if err := wsjson.Write(ctx, ws, protocol.ServerMessage{
			Type:            "tool.request",
			ProtocolVersion: protocol.Version,
			RequestID:       "request-01",
			LeaseID:         "lease-01",
			Operation:       "bash",
			Input:           []byte(`{"command":"echo remote-hands"}`),
		}); err != nil {
			serverErrors <- err
			return
		}

		var result protocol.ToolResult
		if err := wsjson.Read(ctx, ws, &result); err != nil {
			serverErrors <- err
			return
		}
		toolResult <- result
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := New(config.Config{
		ControlPlaneURL: server.URL,
		ID:              "workstation-01",
		Name:            "Test workstation",
		Token:           "secret-token",
		Platform:        "linux",
		Architecture:    "amd64",
		WorkspaceRoots:  []string{workspace},
	}, "0.1.0-test", slog.New(slog.NewTextHandler(io.Discard, nil)))

	clientDone := make(chan error, 1)
	go func() {
		clientDone <- client.connectAndServe(ctx)
	}()

	select {
	case err := <-serverErrors:
		t.Fatal(err)
	case result := <-toolResult:
		if !result.OK {
			t.Fatalf("tool failed: %s (%s)", result.Error, result.ErrorCode)
		}
		output, ok := result.Output.(map[string]any)
		if !ok {
			t.Fatalf("unexpected output shape: %#v", result.Output)
		}
		if output["stdout"] != "remote-hands\n" {
			t.Fatalf("unexpected stdout: %#v", output["stdout"])
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for tool result")
	}

	cancel()
	select {
	case <-clientDone:
	case <-time.After(time.Second):
		t.Fatal("client did not stop after cancellation")
	}
}

func TestContextResultStaysWithinTheEncodedFrameLimit(t *testing.T) {
	t.Parallel()

	writer := &recordingFrameWriter{}
	conn := &safeConn{ws: writer}
	result := protocol.ContextResult{
		OK: true,
		Files: []protocol.ContextFile{{
			Path:    "outpost:/AGENTS.md",
			Content: strings.Repeat("\x00", protocol.MaxFrameBytes/2),
		}},
	}
	bounded, err := conn.writeContextResult(context.Background(), result)
	if err != nil {
		t.Fatal(err)
	}

	if bounded.OK || bounded.ErrorCode != protocol.ErrExecution || len(bounded.Files) != 0 {
		t.Fatalf("oversized encoded context was not replaced with an error: %#v", bounded)
	}
	if len(writer.frames) != 1 || len(writer.frames[0]) > protocol.MaxFrameBytes {
		t.Fatalf("bounded context writes=%d bytes=%d", len(writer.frames), len(writer.frames[0]))
	}
}

// Idle is what gates a self-update swap, so it has to be false for every
// shape of in-flight work, not only for a held lease.
func TestIdleReflectsLeasesAndInFlightRequests(t *testing.T) {
	t.Parallel()

	client := New(config.Config{
		ControlPlaneURL: "https://control.example.com",
		ID:              "workstation-01",
		Name:            "Test workstation",
		Token:           "secret-token",
		WorkspaceRoots:  []string{"/workspace"},
	}, "0.1.0-test", slog.New(slog.NewTextHandler(io.Discard, nil)))

	if !client.Idle() {
		t.Fatal("a fresh client should be idle")
	}

	client.leases.Add(lease.Lease{
		ID:            "lease-01",
		WorkspacePath: "/workspace",
		ExpiresAt:     time.Now().Add(time.Hour),
	})
	if client.Idle() {
		t.Fatal("a client holding a lease is not idle")
	}
	client.leases.Remove("lease-01")
	if !client.Idle() {
		t.Fatal("releasing the only lease should return the client to idle")
	}

	state, first, err := client.beginToolRequest(context.Background(), protocol.ServerMessage{
		RequestID: "request-01",
		LeaseID:   "lease-01",
		Operation: "bash",
		Input:     []byte(`{"command":"sleep 1"}`),
	})
	if err != nil || !first {
		t.Fatalf("unexpected request registration: first=%v err=%v", first, err)
	}
	if client.Idle() {
		t.Fatal("a client with an uncompleted request is not idle")
	}
	client.completeToolRequest("request-01", state, protocol.ToolResult{OK: true})
	if !client.Idle() {
		t.Fatal("a completed request should leave the client idle")
	}
}

func TestOnRegisteredFiresAfterTheAcknowledgement(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		ws, err := websocket.Accept(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer ws.CloseNow()

		var registration protocol.Registration
		if err := wsjson.Read(request.Context(), ws, &registration); err != nil {
			t.Error(err)
			return
		}
		if err := wsjson.Write(request.Context(), ws, protocol.ServerMessage{
			Type:                "outpost.registered",
			ProtocolVersion:     protocol.Version,
			OutpostID:           registration.OutpostID,
			ConnectionID:        "connection-01",
			RegisteredAt:        time.Now().UTC(),
			HeartbeatIntervalMS: 60_000,
		}); err != nil {
			t.Error(err)
			return
		}
		// Keep reading so the client's closing handshake is answered rather
		// than timing out against a server that has stopped listening.
		for {
			var message protocol.ServerMessage
			if err := wsjson.Read(request.Context(), ws, &message); err != nil {
				return
			}
		}
	}))
	defer server.Close()

	client := New(config.Config{
		ControlPlaneURL: server.URL,
		ID:              "workstation-01",
		Name:            "Test workstation",
		Token:           "secret-token",
		WorkspaceRoots:  []string{"/workspace"},
	}, "0.1.0-test", slog.New(slog.NewTextHandler(io.Discard, nil)))

	registered := make(chan struct{}, 1)
	client.OnRegistered(func() { registered <- struct{}{} })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	clientDone := make(chan error, 1)
	go func() { clientDone <- client.connectAndServe(ctx) }()

	select {
	case <-registered:
	case <-time.After(5 * time.Second):
		t.Fatal("the registration hook never ran")
	}

	cancel()
	select {
	case <-clientDone:
	case <-time.After(time.Second):
		t.Fatal("client did not stop after cancellation")
	}
}

type testError struct {
	message string
}

func (e *testError) Error() string {
	return e.message
}
