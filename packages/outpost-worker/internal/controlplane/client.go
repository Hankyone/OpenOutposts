package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/config"
	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/identity"
	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/lease"
	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/ops"
	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/picontext"
	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/protocol"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// maxToolRuntime bounds any single tool execution regardless of its own
// timeout handling, so a stuck operation cannot pin a goroutine forever.
const maxToolRuntime = 10 * time.Minute

// maxConcurrentTools caps in-flight operations so a flood of tool requests
// cannot exhaust the host with processes and goroutines.
const maxConcurrentTools = 8

// maxRememberedToolRequests bounds the reconnect deduplication cache. Request
// IDs are UUIDs and retries happen immediately after a dropped connection, so
// retaining the latest results is enough to cover the unsafe replay window
// without growing for the lifetime of the process.
const maxRememberedToolRequests = 2048

// defaultDialTimeout bounds the WebSocket handshake. The connection context
// has no deadline of its own, so without this a black-holed control-plane
// address parks the worker inside Dial for as long as the kernel keeps the
// SYN retrying.
const defaultDialTimeout = 30 * time.Second

// missedHeartbeatAcks is how many heartbeat intervals may pass without an
// acknowledgement before the connection is treated as half-open. Heartbeats
// keep flowing into a NAT rebind or a silently dropping middlebox without ever
// erroring, so their acknowledgements are the only evidence the control plane
// is still on the other end; the reconnect loop hangs off a close that would
// otherwise never happen.
const missedHeartbeatAcks = 3

const (
	defaultBaseReconnectDelay = time.Second
	defaultMaxReconnectDelay  = 30 * time.Second
	// defaultHealthyConnectionAge is how long a connection must last to count
	// as proof the control plane is reachable, which resets the reconnect
	// delay. Without it a burst of early flapping raises the delay to its
	// ceiling and every later reconnect inherits it, however long the
	// intervening connection lived.
	defaultHealthyConnectionAge = time.Minute
)

var (
	errToolRequestCancelled = errors.New("tool request cancelled")
	errToolRequestCompleted = errors.New("tool request completed")
)

type toolExecutor interface {
	Execute(context.Context, string, string, json.RawMessage) (any, error)
}

type toolRequestState struct {
	leaseID   string
	signature string
	ctx       context.Context
	cancel    context.CancelCauseFunc
	done      chan struct{}
	result    protocol.ToolResult
	completed bool
}

type Client struct {
	config    config.Config
	version   string
	log       *slog.Logger
	leases    *lease.Store
	executor  toolExecutor
	toolSlots chan struct{}

	dialTimeout          time.Duration
	baseReconnectDelay   time.Duration
	maxReconnectDelay    time.Duration
	healthyConnectionAge time.Duration

	requestsMu          sync.Mutex
	requests            map[string]*toolRequestState
	completedRequestIDs []string

	hooksMu         sync.Mutex
	registeredHooks []func()
}

// Idle reports whether this worker is doing no leased work at all: no lease
// held, and no tool request still running. The self-updater waits on it, so it
// must be conservative — a request that has been registered but not yet picked
// up by its goroutine already counts as busy.
func (c *Client) Idle() bool {
	if c.leases.Count() > 0 {
		return false
	}
	c.requestsMu.Lock()
	defer c.requestsMu.Unlock()
	for _, state := range c.requests {
		if !state.completed {
			return false
		}
	}
	return true
}

// OnRegistered registers a hook to run after every successful registration.
// Registration acknowledged by the control plane is the narrowest proof this
// build actually works, which is what the self-updater confirms against.
func (c *Client) OnRegistered(hook func()) {
	if hook == nil {
		return
	}
	c.hooksMu.Lock()
	defer c.hooksMu.Unlock()
	c.registeredHooks = append(c.registeredHooks, hook)
}

// notifyRegistered runs each hook on its own goroutine: a hook that blocks
// must not hold up the connection's read loop.
func (c *Client) notifyRegistered() {
	c.hooksMu.Lock()
	hooks := append([]func(){}, c.registeredHooks...)
	c.hooksMu.Unlock()
	for _, hook := range hooks {
		go hook()
	}
}

func New(cfg config.Config, version string, logger *slog.Logger) *Client {
	return &Client{
		config:               cfg,
		version:              version,
		log:                  logger,
		leases:               lease.NewStore(),
		executor:             ops.Executor{},
		toolSlots:            make(chan struct{}, maxConcurrentTools),
		dialTimeout:          defaultDialTimeout,
		baseReconnectDelay:   defaultBaseReconnectDelay,
		maxReconnectDelay:    defaultMaxReconnectDelay,
		healthyConnectionAge: defaultHealthyConnectionAge,
		requests:             make(map[string]*toolRequestState),
	}
}

func toolRequestSignature(message protocol.ServerMessage) string {
	return message.LeaseID + "\x00" + message.Operation + "\x00" + string(message.Input)
}

func (c *Client) beginToolRequest(
	ctx context.Context,
	message protocol.ServerMessage,
) (*toolRequestState, bool, error) {
	signature := toolRequestSignature(message)
	c.requestsMu.Lock()
	defer c.requestsMu.Unlock()
	if existing := c.requests[message.RequestID]; existing != nil {
		if existing.signature != signature {
			return nil, false, fmt.Errorf("request ID %s was reused for different work", message.RequestID)
		}
		return existing, false, nil
	}

	requestCtx, cancel := context.WithCancelCause(ctx)
	state := &toolRequestState{
		leaseID:   message.LeaseID,
		signature: signature,
		ctx:       requestCtx,
		cancel:    cancel,
		done:      make(chan struct{}),
	}
	c.requests[message.RequestID] = state
	return state, true, nil
}

func (c *Client) completeToolRequest(requestID string, state *toolRequestState, result protocol.ToolResult) {
	c.requestsMu.Lock()
	if state.completed {
		c.requestsMu.Unlock()
		return
	}
	state.result = result
	state.completed = true
	close(state.done)
	c.completedRequestIDs = append(c.completedRequestIDs, requestID)

	for len(c.completedRequestIDs) > maxRememberedToolRequests {
		oldest := c.completedRequestIDs[0]
		c.completedRequestIDs = c.completedRequestIDs[1:]
		if remembered := c.requests[oldest]; remembered != nil && remembered.completed {
			delete(c.requests, oldest)
		}
	}
	c.requestsMu.Unlock()

	// The request context is a child of the connection context and stays
	// registered on it until it is cancelled. A connection lives for days, so
	// completing without cancelling accrues one retained child per tool call
	// for the life of the connection. Results are sent on the connection
	// context, not this one, so cancelling here cannot cut the reply short.
	state.cancel(errToolRequestCompleted)
}

// cancelToolRequests reaches requests before and after they obtain capacity.
// Omitting requestID is the lease-wide stop used by the product stop button.
func (c *Client) cancelToolRequests(leaseID, requestID string) {
	c.requestsMu.Lock()
	cancels := make([]context.CancelCauseFunc, 0)
	for id, state := range c.requests {
		if state.leaseID == leaseID && !state.completed && (requestID == "" || id == requestID) {
			cancels = append(cancels, state.cancel)
		}
	}
	c.requestsMu.Unlock()

	for _, cancel := range cancels {
		cancel(errToolRequestCancelled)
	}
}

func (c *Client) Run(ctx context.Context) error {
	backoff := c.baseReconnectDelay
	for {
		connectedAt := time.Now()
		err := c.connectAndServe(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if time.Since(connectedAt) >= c.healthyConnectionAge {
			backoff = c.baseReconnectDelay
		}

		delay := jitteredDelay(backoff)
		c.log.Warn("outpost connection ended", "error", err, "reconnect_in", delay)

		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		backoff = min(backoff*2, c.maxReconnectDelay)
	}
}

// jitteredDelay spreads a reconnect over the upper half of its window. A
// control-plane deploy drops every connection at once; without jitter the
// whole fleet comes back on the same boundary and keeps re-synchronising on
// every subsequent one.
func jitteredDelay(delay time.Duration) time.Duration {
	if delay <= 0 {
		return 0
	}
	half := delay / 2
	return delay - half + time.Duration(rand.Int64N(int64(half)+1))
}

func (c *Client) connectAndServe(ctx context.Context) error {
	connectionCtx, cancelConnection := context.WithCancel(ctx)
	defer cancelConnection()

	// Leases only survive as long as their connection; the control plane
	// re-offers active leases after every registration.
	c.leases.Clear()

	endpoint, err := c.endpoint()
	if err != nil {
		return err
	}

	headers := http.Header{}
	if len(c.config.PrivateKey) > 0 {
		proofRequest, proofErr := http.NewRequest(http.MethodGet, endpoint, nil)
		if proofErr != nil {
			return fmt.Errorf("build connection proof: %w", proofErr)
		}
		if proofErr := identity.AddProof(
			proofRequest,
			c.config.ID,
			c.config.KeyFingerprint,
			c.config.PrivateKey,
			time.Now(),
		); proofErr != nil {
			return proofErr
		}
		headers = proofRequest.Header
	} else {
		c.log.Warn("using legacy shared-token authentication; migrate this machine identity")
		headers.Set("Authorization", "Bearer "+c.config.Token)
	}
	dialCtx, cancelDial := context.WithTimeout(connectionCtx, c.dialTimeout)
	ws, response, err := websocket.Dial(dialCtx, endpoint, &websocket.DialOptions{
		HTTPHeader: headers,
	})
	// The dial deadline covers the handshake only; net/http hands the upgraded
	// connection over and stops watching the request context, so releasing it
	// here does not disturb the socket.
	cancelDial()
	if err != nil {
		if response != nil {
			return fmt.Errorf("connect to control plane: HTTP %d: %w", response.StatusCode, err)
		}
		return fmt.Errorf("connect to control plane: %w", err)
	}
	defer ws.CloseNow()
	ws.SetReadLimit(protocol.MaxFrameBytes)
	conn := &safeConn{ws: ws}

	registration := protocol.Registration{
		Type:            "outpost.register",
		ProtocolVersion: protocol.Version,
		OutpostID:       c.config.ID,
		Name:            c.config.Name,
		WorkerVersion:   c.version,
		Capabilities: protocol.Capabilities{
			Platform:       c.config.Platform,
			Architecture:   c.config.Architecture,
			Operations:     ops.Operations,
			WorkspaceRoots: c.config.WorkspaceRoots,
		},
	}
	if err := conn.write(connectionCtx, registration); err != nil {
		return fmt.Errorf("send registration: %w", err)
	}

	handshakeCtx, cancelHandshake := context.WithTimeout(connectionCtx, 10*time.Second)
	var acknowledged protocol.ServerMessage
	err = wsjson.Read(handshakeCtx, ws, &acknowledged)
	cancelHandshake()
	if err != nil {
		return fmt.Errorf("read registration acknowledgement: %w", err)
	}
	if acknowledged.Type == "outpost.error" {
		return fmt.Errorf("registration rejected (%s): %s", acknowledged.Code, acknowledged.Message)
	}
	if acknowledged.ProtocolVersion != protocol.Version {
		return fmt.Errorf(
			"control plane acknowledged protocol version %d; this worker speaks %d",
			acknowledged.ProtocolVersion,
			protocol.Version,
		)
	}
	if acknowledged.Type != "outpost.registered" || acknowledged.OutpostID != c.config.ID || acknowledged.HeartbeatIntervalMS <= 0 {
		return errors.New("control plane returned an invalid registration acknowledgement")
	}

	interval := time.Duration(acknowledged.HeartbeatIntervalMS) * time.Millisecond
	c.log.Info("outpost connected", "outpost_id", c.config.ID, "heartbeat_interval", interval)
	c.notifyRegistered()

	messages := make(chan protocol.ServerMessage)
	readErrors := make(chan error, 1)
	go c.readMessages(connectionCtx, ws, messages, readErrors)

	acknowledgedAt := time.Now()
	staleAfter := missedHeartbeatAcks * interval

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-connectionCtx.Done():
			_ = ws.Close(websocket.StatusNormalClosure, "worker shutting down")
			return connectionCtx.Err()
		case err := <-readErrors:
			return fmt.Errorf("read control plane message: %w", err)
		case message := <-messages:
			if message.Type == "outpost.heartbeat_ack" {
				acknowledgedAt = time.Now()
			}
			if err := c.handleMessage(connectionCtx, conn, message); err != nil {
				return err
			}
		case sentAt := <-ticker.C:
			if silence := sentAt.Sub(acknowledgedAt); silence > staleAfter {
				// Returning tears the connection down so Run can redial. A
				// half-open socket accepts writes forever, so the worker would
				// otherwise stay invisible to the control plane indefinitely.
				return fmt.Errorf(
					"control plane stopped acknowledging heartbeats %s ago",
					silence.Round(time.Millisecond),
				)
			}
			heartbeat := protocol.Heartbeat{
				Type:            "outpost.heartbeat",
				ProtocolVersion: protocol.Version,
				OutpostID:       c.config.ID,
				SentAt:          sentAt.UTC(),
			}
			if err := conn.write(connectionCtx, heartbeat); err != nil {
				return fmt.Errorf("send heartbeat: %w", err)
			}
		}
	}
}

func (c *Client) handleMessage(ctx context.Context, conn *safeConn, message protocol.ServerMessage) error {
	if message.ProtocolVersion != protocol.Version {
		return fmt.Errorf(
			"control plane sent protocol version %d; this worker speaks %d",
			message.ProtocolVersion,
			protocol.Version,
		)
	}
	switch message.Type {
	case "outpost.error":
		return fmt.Errorf("control plane error (%s): %s", message.Code, message.Message)
	case "outpost.heartbeat_ack":
		return nil
	case "lease.offer":
		return c.handleLeaseOffer(ctx, conn, message)
	case "lease.release":
		c.leases.Remove(message.LeaseID)
		c.cancelToolRequests(message.LeaseID, "")
		c.log.Info("lease released", "lease_id", message.LeaseID, "reason", message.Reason)
		return nil
	case "tool.cancel":
		c.cancelToolRequests(message.LeaseID, message.RequestID)
		c.log.Info(
			"tool work cancelled",
			"lease_id", message.LeaseID,
			"request_id", message.RequestID,
		)
		return nil
	case "tool.request":
		// Register before starting the goroutine. The next wire message may be
		// a stop, and it must be able to find this request even if the scheduler
		// has not run the request handler yet.
		state, firstDelivery, requestErr := c.beginToolRequest(ctx, message)
		go c.handleToolRequest(ctx, conn, message, state, firstDelivery, requestErr)
		return nil
	case "context.request":
		// Context discovery is fixed, read-only startup work rather than a
		// model tool. Keep it off the socket read loop all the same: a slow
		// filesystem must not stop heartbeats or lease releases being read.
		go c.handleContextRequest(ctx, conn, message)
		return nil
	default:
		c.log.Warn("ignoring unknown control plane message", "type", message.Type)
		return nil
	}
}

func (c *Client) handleLeaseOffer(ctx context.Context, conn *safeConn, message protocol.ServerMessage) error {
	workspaceRoot, reason := c.leaseWorkspaceRoot(message.WorkspacePath)
	if reason != "" {
		c.log.Warn("lease rejected", "lease_id", message.LeaseID, "reason", reason)
		return conn.write(ctx, protocol.LeaseRejected{
			Type:            "lease.rejected",
			ProtocolVersion: protocol.Version,
			LeaseID:         message.LeaseID,
			Reason:          reason,
		})
	}

	c.leases.Add(lease.Lease{
		ID:               message.LeaseID,
		ProductSessionID: message.ProductSessionID,
		WorkspacePath:    message.WorkspacePath,
		WorkspaceRoot:    workspaceRoot,
		ExpiresAt:        message.ExpiresAt,
	})
	c.log.Info("lease accepted", "lease_id", message.LeaseID, "workspace", message.WorkspacePath)
	return conn.write(ctx, protocol.LeaseAccepted{
		Type:            "lease.accepted",
		ProtocolVersion: protocol.Version,
		LeaseID:         message.LeaseID,
	})
}

func (c *Client) leaseWorkspaceRoot(workspacePath string) (string, string) {
	if !filepath.IsAbs(workspacePath) {
		return "", fmt.Sprintf("workspace path %q is not absolute", workspacePath)
	}
	info, err := os.Stat(workspacePath)
	if err != nil || !info.IsDir() {
		return "", fmt.Sprintf("workspace path %q is not an accessible directory", workspacePath)
	}
	// Roots are mandatory (config validation) — never accept a lease without
	// them even if validation was bypassed.
	if len(c.config.WorkspaceRoots) == 0 {
		return "", "no workspace roots are configured on this worker"
	}
	// Compare the symlink-resolved workspace against symlink-resolved roots,
	// so a symlink inside an allowed root cannot smuggle a lease elsewhere.
	resolvedWorkspace, err := filepath.EvalSymlinks(workspacePath)
	if err != nil {
		return "", fmt.Sprintf("workspace path %q cannot be resolved", workspacePath)
	}
	matchedRoot := ""
	for _, root := range c.config.WorkspaceRoots {
		resolvedRoot, rootErr := filepath.EvalSymlinks(root)
		if rootErr != nil {
			continue
		}
		if resolvedWorkspace == resolvedRoot ||
			strings.HasPrefix(resolvedWorkspace, resolvedRoot+string(filepath.Separator)) {
			// Nested configured roots are valid. The most specific one is the
			// virtual filesystem root whose AGENTS.md governs this workspace.
			if len(resolvedRoot) > len(matchedRoot) {
				matchedRoot = resolvedRoot
			}
		}
	}
	if matchedRoot == "" {
		return "", fmt.Sprintf("workspace path %q is outside the configured workspace roots", workspacePath)
	}
	return matchedRoot, ""
}

func (c *Client) handleContextRequest(
	ctx context.Context,
	conn *safeConn,
	message protocol.ServerMessage,
) {
	result := protocol.ContextResult{
		Type:            "context.result",
		ProtocolVersion: protocol.Version,
		RequestID:       message.RequestID,
		LeaseID:         message.LeaseID,
		Files:           []protocol.ContextFile{},
	}
	held, known := c.leases.Get(message.LeaseID)
	switch {
	case !known:
		result.Error = fmt.Sprintf("lease %s is not active on this worker", message.LeaseID)
		result.ErrorCode = protocol.ErrLeaseUnknown
	case time.Now().After(held.ExpiresAt):
		c.leases.Remove(message.LeaseID)
		c.cancelToolRequests(message.LeaseID, "")
		result.Error = fmt.Sprintf("lease %s has expired", message.LeaseID)
		result.ErrorCode = protocol.ErrLeaseExpired
	default:
		resolvedWorkspace, err := filepath.EvalSymlinks(held.WorkspacePath)
		if err != nil {
			result.Error = fmt.Sprintf("resolve workspace context: %v", err)
			result.ErrorCode = protocol.ErrExecution
			break
		}
		files, warnings, discoverErr := picontext.Discover(held.WorkspaceRoot, resolvedWorkspace)
		for _, warning := range warnings {
			c.log.Warn("workspace context file skipped", "lease_id", message.LeaseID, "warning", warning)
		}
		if discoverErr != nil {
			result.Error = discoverErr.Error()
			result.ErrorCode = protocol.ErrExecution
			break
		}
		if _, stillHeld := c.leases.Get(message.LeaseID); !stillHeld {
			result.Error = fmt.Sprintf("lease %s was released during context discovery", message.LeaseID)
			result.ErrorCode = protocol.ErrLeaseUnknown
			break
		}
		for _, file := range files {
			result.Files = append(
				result.Files,
				protocol.ContextFile{Path: file.Path, Content: file.Content},
			)
		}
		result.OK = true
	}
	writeCtx, cancelWrite := context.WithTimeout(ctx, 30*time.Second)
	defer cancelWrite()
	if _, err := conn.writeContextResult(writeCtx, result); err != nil {
		c.log.Error("send context result", "request_id", result.RequestID, "error", err)
	}
}

func (c *Client) handleToolRequest(
	ctx context.Context,
	conn *safeConn,
	message protocol.ServerMessage,
	state *toolRequestState,
	firstDelivery bool,
	requestErr error,
) {
	result := protocol.ToolResult{
		Type:            "tool.result",
		ProtocolVersion: protocol.Version,
		RequestID:       message.RequestID,
		LeaseID:         message.LeaseID,
	}

	if requestErr != nil {
		result.Error = requestErr.Error()
		result.ErrorCode = protocol.ErrInvalidInput
		_ = c.sendToolResult(ctx, conn, result)
		return
	}
	if !firstDelivery {
		select {
		case <-state.done:
			_ = c.sendToolResult(ctx, conn, state.result)
		case <-ctx.Done():
		}
		return
	}

	finish := func() {
		bounded := c.sendToolResult(ctx, conn, result)
		c.completeToolRequest(message.RequestID, state, bounded)
	}

	held, known := c.leases.Get(message.LeaseID)
	switch {
	case !known:
		result.Error = fmt.Sprintf("lease %s is not active on this worker", message.LeaseID)
		result.ErrorCode = protocol.ErrLeaseUnknown
		finish()
		return
	case time.Now().After(held.ExpiresAt):
		c.leases.Remove(message.LeaseID)
		c.cancelToolRequests(message.LeaseID, "")
		result.Error = fmt.Sprintf("lease %s has expired", message.LeaseID)
		result.ErrorCode = protocol.ErrLeaseExpired
		finish()
		return
	default:
		slotTimer := time.NewTimer(30 * time.Second)
		defer slotTimer.Stop()
		select {
		case c.toolSlots <- struct{}{}:
			// Cancellation and capacity can become ready together. Check the
			// request again after taking a slot so a stopped queued request
			// never reaches the executor.
			if state.ctx.Err() != nil {
				<-c.toolSlots
				result.Error = "tool request was cancelled before execution"
				result.ErrorCode = protocol.ErrCancelled
				finish()
				return
			}
		case <-slotTimer.C:
			result.Error = "worker is at capacity; retry shortly"
			result.ErrorCode = protocol.ErrExecution
			finish()
			return
		case <-state.ctx.Done():
			result.Error = "tool request was cancelled before execution"
			result.ErrorCode = protocol.ErrCancelled
			finish()
			return
		}

		// The lease may have been released or expired while this request
		// waited for a slot — re-check before touching the machine.
		if refreshed, stillHeld := c.leases.Get(message.LeaseID); !stillHeld {
			<-c.toolSlots
			result.Error = fmt.Sprintf("lease %s was released while the request was queued", message.LeaseID)
			result.ErrorCode = protocol.ErrLeaseUnknown
			finish()
			return
		} else if time.Now().After(refreshed.ExpiresAt) {
			<-c.toolSlots
			result.Error = fmt.Sprintf("lease %s expired while the request was queued", message.LeaseID)
			result.ErrorCode = protocol.ErrLeaseExpired
			finish()
			return
		}

		runCtx, cancel := context.WithTimeout(state.ctx, maxToolRuntime)
		output, err := c.executor.Execute(runCtx, held.WorkspacePath, message.Operation, message.Input)
		cancel()
		<-c.toolSlots
		if state.ctx.Err() != nil {
			result.Error = "tool request was cancelled"
			result.ErrorCode = protocol.ErrCancelled
		} else if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			result.Error = fmt.Sprintf("tool request exceeded the worker limit of %s", maxToolRuntime)
			result.ErrorCode = protocol.ErrTimeout
		} else if err != nil {
			var opError *ops.Error
			if errors.As(err, &opError) {
				result.Error = opError.Message
				result.ErrorCode = opError.Code
			} else {
				result.Error = err.Error()
				result.ErrorCode = protocol.ErrExecution
			}
		} else {
			result.OK = true
			result.Output = output
		}
		finish()
		return
	}
}

func (c *Client) sendToolResult(
	ctx context.Context,
	conn *safeConn,
	result protocol.ToolResult,
) protocol.ToolResult {
	writeCtx, cancelWrite := context.WithTimeout(ctx, 30*time.Second)
	defer cancelWrite()
	bounded, err := conn.writeToolResult(writeCtx, result)
	if err != nil {
		c.log.Error("send tool result", "request_id", result.RequestID, "error", err)
	}
	return bounded
}

func (c *Client) readMessages(ctx context.Context, ws *websocket.Conn, messages chan<- protocol.ServerMessage, readErrors chan<- error) {
	for {
		var message protocol.ServerMessage
		if err := wsjson.Read(ctx, ws, &message); err != nil {
			readErrors <- err
			return
		}
		select {
		case messages <- message:
		case <-ctx.Done():
			return
		}
	}
}

func (c *Client) endpoint() (string, error) {
	endpoint, err := url.Parse(c.config.ControlPlaneURL)
	if err != nil {
		return "", fmt.Errorf("parse control plane URL: %w", err)
	}
	switch endpoint.Scheme {
	case "http":
		endpoint.Scheme = "ws"
	case "https":
		endpoint.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("unsupported control plane URL scheme %q", endpoint.Scheme)
	}
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/outposts/" + c.config.ID + "/connect"
	endpoint.RawQuery = ""
	endpoint.Fragment = ""
	return endpoint.String(), nil
}
