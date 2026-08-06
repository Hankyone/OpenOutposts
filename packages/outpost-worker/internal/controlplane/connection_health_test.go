package controlplane

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/config"
	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/protocol"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestCompletedToolRequestReleasesItsContext(t *testing.T) {
	t.Parallel()
	client := New(config.Config{
		ControlPlaneURL: "https://control.example",
		ID:              "workstation-01",
		Name:            "Test workstation",
		Token:           "secret-token",
		Platform:        "linux",
		Architecture:    "amd64",
		WorkspaceRoots:  []string{t.TempDir()},
	}, "0.1.0-test", discardLogger())

	connectionCtx, cancelConnection := context.WithCancel(context.Background())
	defer cancelConnection()

	state, firstDelivery, err := client.beginToolRequest(connectionCtx, testToolRequest("request-01"))
	if err != nil || !firstDelivery {
		t.Fatalf("unexpected begin result: firstDelivery=%v err=%v", firstDelivery, err)
	}

	client.completeToolRequest("request-01", state, protocol.ToolResult{RequestID: "request-01"})

	// A completed request stays in the deduplication cache, so the only thing
	// that detaches its context from the connection is cancelling it. Leaving
	// it attached accrues one child per tool call for the life of a connection
	// that runs for days.
	if state.ctx.Err() == nil {
		t.Fatal("completed tool request left its context attached to the connection context")
	}
	if !errors.Is(context.Cause(state.ctx), errToolRequestCompleted) {
		t.Fatalf("unexpected cancellation cause: %v", context.Cause(state.ctx))
	}

	client.requestsMu.Lock()
	remembered := client.requests["request-01"]
	client.requestsMu.Unlock()
	if remembered == nil {
		t.Fatal("completing a request must not drop it from the deduplication cache")
	}
	if connectionCtx.Err() != nil {
		t.Fatal("completing a request must not cancel the connection")
	}
}

func TestCompletedToolRequestsDoNotAccumulateOnTheConnection(t *testing.T) {
	t.Parallel()
	client := New(config.Config{
		ControlPlaneURL: "https://control.example",
		ID:              "workstation-01",
		Name:            "Test workstation",
		Token:           "secret-token",
		Platform:        "linux",
		Architecture:    "amd64",
		WorkspaceRoots:  []string{t.TempDir()},
	}, "0.1.0-test", discardLogger())

	connectionCtx, cancelConnection := context.WithCancel(context.Background())
	defer cancelConnection()

	states := make([]*toolRequestState, 0, 64)
	for index := 0; index < 64; index++ {
		message := testToolRequest("request-" + strconv.Itoa(index))
		state, _, err := client.beginToolRequest(connectionCtx, message)
		if err != nil {
			t.Fatal(err)
		}
		client.completeToolRequest(message.RequestID, state, protocol.ToolResult{})
		states = append(states, state)
	}

	for index, state := range states {
		if state.ctx.Err() == nil {
			t.Fatalf("request %d is still attached to the connection context", index)
		}
	}
}

func TestDialTimeoutEndsAStalledConnectionAttempt(t *testing.T) {
	t.Parallel()

	// A listener that accepts and then says nothing is what a black-holing
	// middlebox looks like: the TCP handshake completes and the WebSocket
	// handshake never does.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 4)
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			accepted <- conn
		}
	}()
	t.Cleanup(func() {
		close(accepted)
		for conn := range accepted {
			_ = conn.Close()
		}
	})

	client := New(config.Config{
		ControlPlaneURL: "http://" + listener.Addr().String(),
		ID:              "workstation-01",
		Name:            "Test workstation",
		Token:           "secret-token",
		Platform:        "linux",
		Architecture:    "amd64",
		WorkspaceRoots:  []string{t.TempDir()},
	}, "0.1.0-test", discardLogger())
	client.dialTimeout = 200 * time.Millisecond

	done := make(chan error, 1)
	go func() { done <- client.connectAndServe(context.Background()) }()

	select {
	case connectErr := <-done:
		if connectErr == nil {
			t.Fatal("expected the stalled dial to fail")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("dial did not time out; the worker would wait on a dead address forever")
	}
}

func TestUnacknowledgedHeartbeatsTearDownTheConnection(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		ws, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		ctx := request.Context()

		var registration protocol.Registration
		if err := wsjson.Read(ctx, ws, &registration); err != nil {
			return
		}
		if err := wsjson.Write(ctx, ws, protocol.ServerMessage{
			Type:                "outpost.registered",
			ProtocolVersion:     protocol.Version,
			OutpostID:           registration.OutpostID,
			ConnectionID:        "connection-silent",
			RegisteredAt:        time.Now().UTC(),
			HeartbeatIntervalMS: 50,
		}); err != nil {
			return
		}
		// Drain heartbeats and never acknowledge one: the socket stays open
		// and writable, which is exactly how a half-open path presents.
		for {
			var discarded protocol.Heartbeat
			if err := wsjson.Read(ctx, ws, &discarded); err != nil {
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
		Platform:        "linux",
		Architecture:    "amd64",
		WorkspaceRoots:  []string{t.TempDir()},
	}, "0.1.0-test", discardLogger())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- client.connectAndServe(ctx) }()

	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "acknowledging heartbeats") {
			t.Fatalf("expected the connection to be torn down for silence, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("an unacknowledged connection stayed up; the worker is invisible and never reconnects")
	}
}

func TestJitteredDelayStaysInTheUpperHalfOfItsWindow(t *testing.T) {
	t.Parallel()

	if got := jitteredDelay(0); got != 0 {
		t.Fatalf("expected no delay for a zero window, got %s", got)
	}

	const window = 400 * time.Millisecond
	distinct := make(map[time.Duration]struct{})
	for attempt := 0; attempt < 2_000; attempt++ {
		delay := jitteredDelay(window)
		if delay < window/2 || delay > window {
			t.Fatalf("delay %s escaped [%s, %s]", delay, window/2, window)
		}
		distinct[delay] = struct{}{}
	}
	if len(distinct) < 2 {
		t.Fatal("reconnects are not jittered; a control-plane deploy re-synchronises the fleet")
	}
}

func TestRunResetsTheReconnectDelayAfterAHealthyConnection(t *testing.T) {
	const (
		fastFailures = 6
		healthyFor   = 120 * time.Millisecond
	)

	var attempts atomic.Int32
	connectedAt := make(chan time.Time, 16)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		attempt := attempts.Add(1)
		select {
		case connectedAt <- time.Now():
		default:
		}
		ws, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		if attempt > fastFailures {
			if err := registerTestWorker(request.Context(), ws, "connection-healthy"); err != nil {
				return
			}
			time.Sleep(healthyFor)
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
		WorkspaceRoots:  []string{t.TempDir()},
	}, "0.1.0-test", discardLogger())
	client.baseReconnectDelay = 10 * time.Millisecond
	client.maxReconnectDelay = 400 * time.Millisecond
	client.healthyConnectionAge = 60 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan error, 1)
	go func() { runDone <- client.Run(ctx) }()

	times := make([]time.Time, 0, fastFailures+2)
	deadline := time.After(10 * time.Second)
	for len(times) < fastFailures+2 {
		select {
		case at := <-connectedAt:
			times = append(times, at)
		case <-deadline:
			t.Fatalf("only %d reconnects arrived; the worker stopped retrying", len(times))
		}
	}

	// By the sixth failure the delay has doubled to its ceiling. The seventh
	// connection stays up past healthyConnectionAge, so the eighth must follow
	// it by roughly the base delay rather than the inherited ceiling.
	gap := times[fastFailures+1].Sub(times[fastFailures])
	if gap > healthyFor+250*time.Millisecond {
		t.Fatalf("reconnect after a healthy connection waited %s; the delay was never reset", gap)
	}

	cancel()
	select {
	case err := <-runDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected Run to return the cancellation, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop after cancellation")
	}
}
