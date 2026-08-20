package controlplane

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/protocol"
	"github.com/coder/websocket"
)

// ErrFrameTooLarge is returned before a value reaches the WebSocket. It only
// carries sizes; output content never enters the error or worker logs.
type ErrFrameTooLarge struct {
	EncodedBytes int
	AllowedBytes int
}

func (e *ErrFrameTooLarge) Error() string {
	return fmt.Sprintf(
		"encoded WebSocket frame is %d bytes; limit is %d bytes",
		e.EncodedBytes,
		e.AllowedBytes,
	)
}

func encodeFrame(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode WebSocket frame: %w", err)
	}
	if len(encoded) > protocol.MaxFrameBytes {
		return nil, &ErrFrameTooLarge{
			EncodedBytes: len(encoded),
			AllowedBytes: protocol.MaxFrameBytes,
		}
	}
	return encoded, nil
}

type websocketFrameWriter interface {
	Write(context.Context, websocket.MessageType, []byte) error
}

// safeConn serializes the complete encode, size decision and write so tool
// goroutines and the heartbeat loop can share one WebSocket.
type safeConn struct {
	mu sync.Mutex
	ws websocketFrameWriter
}

func (s *safeConn) write(ctx context.Context, value any) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	encoded, err := encodeFrame(value)
	if err != nil {
		return err
	}
	return s.ws.Write(ctx, websocket.MessageText, encoded)
}

// writeToolResult replaces only encoding and frame-size failures. Transport
// failures return directly, since retrying another value on the same failed
// connection would hide the actual problem.
func (s *safeConn) writeToolResult(
	ctx context.Context,
	result protocol.ToolResult,
) (protocol.ToolResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	encoded, err := encodeFrame(result)
	if err != nil {
		result = oversizedToolResult(result)
		encoded, err = encodeFrame(result)
		if err != nil {
			return result, fmt.Errorf("encode bounded tool result: %w", err)
		}
	}
	return result, s.ws.Write(ctx, websocket.MessageText, encoded)
}

func oversizedToolResult(result protocol.ToolResult) protocol.ToolResult {
	return protocol.ToolResult{
		Type:            "tool.result",
		ProtocolVersion: protocol.Version,
		RequestID:       result.RequestID,
		LeaseID:         result.LeaseID,
		Output:          nil,
		Error:           "worker result exceeded the protocol frame limit",
		ErrorCode:       protocol.ErrExecution,
	}
}

func (s *safeConn) writeContextResult(
	ctx context.Context,
	result protocol.ContextResult,
) (protocol.ContextResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	encoded, err := encodeFrame(result)
	if err != nil {
		result.OK = false
		result.Files = []protocol.ContextFile{}
		result.Error = fmt.Sprintf(
			"workspace context exceeds the %d-byte encoded frame limit",
			protocol.MaxFrameBytes,
		)
		result.ErrorCode = protocol.ErrExecution
		encoded, err = encodeFrame(result)
		if err != nil {
			return result, fmt.Errorf("encode bounded context result: %w", err)
		}
	}
	return result, s.ws.Write(ctx, websocket.MessageText, encoded)
}
