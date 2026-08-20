package controlplane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/protocol"
	"github.com/coder/websocket"
)

type recordingFrameWriter struct {
	frames [][]byte
	types  []websocket.MessageType
	err    error
}

func (w *recordingFrameWriter) Write(
	_ context.Context,
	messageType websocket.MessageType,
	payload []byte,
) error {
	w.frames = append(w.frames, append([]byte(nil), payload...))
	w.types = append(w.types, messageType)
	return w.err
}

func TestFrameEncoderAcceptsExactLimitAndRejectsOneByteMore(t *testing.T) {
	t.Parallel()

	writer := &recordingFrameWriter{}
	conn := &safeConn{ws: writer}
	exact := strings.Repeat("a", protocol.MaxFrameBytes-2)
	if err := conn.write(context.Background(), exact); err != nil {
		t.Fatal(err)
	}
	if len(writer.frames) != 1 || len(writer.frames[0]) != protocol.MaxFrameBytes {
		t.Fatalf("exact frame write: calls=%d bytes=%d", len(writer.frames), len(writer.frames[0]))
	}
	if writer.types[0] != websocket.MessageText {
		t.Fatalf("message type = %v, want text", writer.types[0])
	}

	err := conn.write(context.Background(), exact+"a")
	var tooLarge *ErrFrameTooLarge
	if !errors.As(err, &tooLarge) {
		t.Fatalf("one byte over returned %v, want ErrFrameTooLarge", err)
	}
	if tooLarge.EncodedBytes != protocol.MaxFrameBytes+1 ||
		tooLarge.AllowedBytes != protocol.MaxFrameBytes {
		t.Fatalf("unexpected size error: %#v", tooLarge)
	}
	if len(writer.frames) != 1 {
		t.Fatalf("oversized frame reached writer; calls=%d", len(writer.frames))
	}
}

func TestOversizedToolResultBecomesBoundedCorrelatedError(t *testing.T) {
	t.Parallel()

	writer := &recordingFrameWriter{}
	conn := &safeConn{ws: writer}
	requestID := strings.Repeat("<", 200)
	leaseID := strings.Repeat("&", 200)
	original := protocol.ToolResult{
		Type:            "tool.result",
		ProtocolVersion: protocol.Version,
		RequestID:       requestID,
		LeaseID:         leaseID,
		OK:              true,
		Output:          strings.Repeat("private-output", protocol.MaxFrameBytes),
	}

	bounded, err := conn.writeToolResult(context.Background(), original)
	if err != nil {
		t.Fatal(err)
	}
	if bounded.OK || bounded.Output != nil || bounded.ErrorCode != protocol.ErrExecution {
		t.Fatalf("unexpected bounded result: %#v", bounded)
	}
	if bounded.RequestID != requestID || bounded.LeaseID != leaseID {
		t.Fatal("bounded result did not preserve correlation identifiers")
	}
	if len(writer.frames) != 1 || len(writer.frames[0]) > protocol.MaxFrameBytes {
		t.Fatalf("fallback writes=%d bytes=%d", len(writer.frames), len(writer.frames[0]))
	}
	if bytes.Contains(writer.frames[0], []byte("private-output")) {
		t.Fatal("fallback frame contains discarded output")
	}

	var decoded protocol.ToolResult
	if err := json.Unmarshal(writer.frames[0], &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.RequestID != requestID || decoded.LeaseID != leaseID || decoded.OK {
		t.Fatalf("unexpected wire fallback: %#v", decoded)
	}

	firstFrame := append([]byte(nil), writer.frames[0]...)
	secondBounded, err := conn.writeToolResult(context.Background(), bounded)
	if err != nil {
		t.Fatal(err)
	}
	if secondBounded != bounded || len(writer.frames) != 2 || !bytes.Equal(firstFrame, writer.frames[1]) {
		t.Fatal("repeated bounded result did not produce the same frame")
	}
}

func TestUnencodableToolResultUsesTheSameFallback(t *testing.T) {
	t.Parallel()

	writer := &recordingFrameWriter{}
	conn := &safeConn{ws: writer}
	bounded, err := conn.writeToolResult(context.Background(), protocol.ToolResult{
		Type:            "tool.result",
		ProtocolVersion: protocol.Version,
		RequestID:       "request-01",
		LeaseID:         "lease-01",
		OK:              true,
		Output:          make(chan struct{}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if bounded.OK || bounded.ErrorCode != protocol.ErrExecution || len(writer.frames) != 1 {
		t.Fatalf("unencodable result was not replaced: %#v", bounded)
	}
}
