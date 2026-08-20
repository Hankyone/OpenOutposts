package protocol

import (
	"encoding/json"
	"time"
)

// Version must track OUTPOST_PROTOCOL_VERSION in packages/outpost-protocol.
// The worker rejects any message stamped with a different one, so the two move
// together or the fleet stops talking to the control plane in an obvious way.
const Version = 5

// MaxFrameBytes is the largest single WebSocket message either side may put on
// the wire. The control plane runs on Cloudflare Workers, which refuses an
// inbound message above 1 MiB by closing the socket, so this bounds the
// worker's outbound results as well as what it is willing to read. Both
// directions must derive from this one number: a worker read limit larger than
// the control plane's inbound limit only hides the mismatch until a large
// result silently drops the connection.
const (
	MaxFrameBytes = 1 << 20

	// MaxToolResultEnvelopeBytes reserves the non-output part of a successful
	// tool.result. Each of the two protocol identifiers may contain 200
	// characters; at encoding/json's worst valid string cost that is
	// 2 * 200 * 6 = 2,400 bytes. The remaining 5,792 bytes cover keys, fixed
	// fields, punctuation and future compatible additions without allowing an
	// operation-local result to consume the transport ceiling.
	MaxToolResultEnvelopeBytes = 8 << 10
	MaxToolOutputBytes         = MaxFrameBytes - MaxToolResultEnvelopeBytes
)

// Overflowing this conversion is a compile error, so the output budget and
// its envelope reserve cannot drift past the one-frame transport ceiling.
const _ = uint(MaxFrameBytes - MaxToolOutputBytes - MaxToolResultEnvelopeBytes)

type Capabilities struct {
	Platform       string   `json:"platform"`
	Architecture   string   `json:"architecture"`
	Operations     []string `json:"operations"`
	WorkspaceRoots []string `json:"workspaceRoots"`
}

type Registration struct {
	Type            string       `json:"type"`
	ProtocolVersion int          `json:"protocolVersion"`
	OutpostID       string       `json:"outpostId"`
	Name            string       `json:"name"`
	WorkerVersion   string       `json:"workerVersion"`
	Capabilities    Capabilities `json:"capabilities"`
}

type Heartbeat struct {
	Type            string    `json:"type"`
	ProtocolVersion int       `json:"protocolVersion"`
	OutpostID       string    `json:"outpostId"`
	SentAt          time.Time `json:"sentAt"`
}

type LeaseAccepted struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	LeaseID         string `json:"leaseId"`
}

type LeaseRejected struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	LeaseID         string `json:"leaseId"`
	Reason          string `json:"reason"`
}

// Tool error codes shared with the TypeScript protocol package.
const (
	ErrLeaseUnknown         = "lease_unknown"
	ErrLeaseExpired         = "lease_expired"
	ErrOperationUnsupported = "operation_unsupported"
	ErrInvalidInput         = "invalid_input"
	ErrPathOutsideWorkspace = "path_outside_workspace"
	ErrExecution            = "execution_error"
	ErrTimeout              = "timeout"
	ErrCancelled            = "cancelled"
)

type ToolResult struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	RequestID       string `json:"requestId"`
	LeaseID         string `json:"leaseId"`
	OK              bool   `json:"ok"`
	Output          any    `json:"output"`
	Error           string `json:"error,omitempty"`
	ErrorCode       string `json:"errorCode,omitempty"`
}

type ContextFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type ContextResult struct {
	Type            string        `json:"type"`
	ProtocolVersion int           `json:"protocolVersion"`
	RequestID       string        `json:"requestId"`
	LeaseID         string        `json:"leaseId"`
	OK              bool          `json:"ok"`
	Files           []ContextFile `json:"files"`
	Error           string        `json:"error,omitempty"`
	ErrorCode       string        `json:"errorCode,omitempty"`
}

// ServerMessage is the union of every control-to-worker message. Fields are
// populated per message type; Type discriminates.
type ServerMessage struct {
	Type                string          `json:"type"`
	ProtocolVersion     int             `json:"protocolVersion"`
	OutpostID           string          `json:"outpostId,omitempty"`
	ConnectionID        string          `json:"connectionId,omitempty"`
	RegisteredAt        time.Time       `json:"registeredAt,omitempty,omitzero"`
	HeartbeatIntervalMS int             `json:"heartbeatIntervalMs,omitempty"`
	ReceivedAt          time.Time       `json:"receivedAt,omitempty,omitzero"`
	Code                string          `json:"code,omitempty"`
	Message             string          `json:"message,omitempty"`
	LeaseID             string          `json:"leaseId,omitempty"`
	ProductSessionID    string          `json:"productSessionId,omitempty"`
	WorkspacePath       string          `json:"workspacePath,omitempty"`
	ExpiresAt           time.Time       `json:"expiresAt,omitempty,omitzero"`
	Reason              string          `json:"reason,omitempty"`
	RequestID           string          `json:"requestId,omitempty"`
	Operation           string          `json:"operation,omitempty"`
	Input               json.RawMessage `json:"input,omitempty"`
}
