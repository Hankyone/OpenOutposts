package ops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/protocol"
)

func sanitizedEnvironment() []string {
	environment := os.Environ()
	kept := environment[:0]
	for _, entry := range environment {
		if strings.HasPrefix(entry, "OPENOUTPOSTS_") {
			continue
		}
		kept = append(kept, entry)
	}
	return kept
}

const (
	defaultBashTimeout = 120 * time.Second
	maxBashTimeout     = 600 * time.Second
	// Stdout carries tool results as large as full-file git patches (the
	// session diff contract allows 512 KiB per file); stderr is diagnostics
	// only. Both budgets are spent in JSON-escaped bytes, because that is what
	// the frame carries: a captured byte costs between one and six bytes once
	// encoding/json writes it into a string, so a cap counted in captured
	// bytes lets a command that reads binary build a frame several times the
	// limit the control plane will accept.
	maxStdoutBytes = 700_000
	maxStderrBytes = 100_000
	// Headroom for the rest of the tool.result envelope: message type,
	// protocol version, request and lease IDs, exit code, duration, and the
	// JSON punctuation around them.
	resultEnvelopeBytes = 8_192
)

// Overflowing this conversion is a compile error, so the two caps and the
// envelope headroom can never be raised past what one frame holds.
const _ = uint(protocol.MaxFrameBytes - maxStdoutBytes - maxStderrBytes - resultEnvelopeBytes)

type bashInput struct {
	Command   string `json:"command"`
	Cwd       string `json:"cwd,omitempty"`
	TimeoutMs int    `json:"timeoutMs,omitempty"`
}

type bashResult struct {
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
	Truncated  bool   `json:"truncated"`
}

// cappedBuffer keeps as much output as fits in limit JSON-escaped bytes and
// records whether it overflowed. It never rejects a write, because the process
// on the other end must keep draining; it simply stops retaining.
type cappedBuffer struct {
	buf       bytes.Buffer
	limit     int
	spent     int
	partial   []byte
	truncated bool
}

// jsonEscapedCost reports the bytes a decoded rune occupies inside a JSON
// string as encoding/json writes it. wsjson encodes with an Encoder, which
// leaves HTML escaping on, so <, > and & cost six. Quote, backslash, newline,
// carriage return and tab cost two; other control bytes cost six; a byte that
// is not valid UTF-8 becomes the six bytes of the escaped replacement
// character; and the line and paragraph separators are escaped too.
func jsonEscapedCost(decoded rune, size int, first byte) int {
	if size == 1 {
		switch {
		case decoded == utf8.RuneError:
			return 6
		case first == '"' || first == '\\' || first == '\n' || first == '\r' || first == '\t':
			return 2
		case first < 0x20 || first == '<' || first == '>' || first == '&':
			return 6
		default:
			return 1
		}
	}
	if decoded == '\u2028' || decoded == '\u2029' {
		return 6
	}
	return size
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	accepted := len(p)
	if c.truncated {
		return accepted, nil
	}

	data := p
	if len(c.partial) > 0 {
		data = append(c.partial, p...)
		c.partial = nil
	}

	for index := 0; index < len(data); {
		// A rune straddling two writes must wait for its remaining bytes
		// rather than be charged as invalid and replaced on the wire.
		if !utf8.FullRune(data[index:]) {
			c.partial = append([]byte(nil), data[index:]...)
			break
		}
		decoded, size := utf8.DecodeRune(data[index:])
		cost := jsonEscapedCost(decoded, size, data[index])
		if c.spent+cost > c.limit {
			c.truncated = true
			break
		}
		c.buf.Write(data[index : index+size])
		c.spent += cost
		index += size
	}
	return accepted, nil
}

// string finalises the buffer, charging any trailing incomplete rune as the
// invalid bytes it turned out to be.
func (c *cappedBuffer) string() string {
	for _, b := range c.partial {
		cost := jsonEscapedCost(utf8.RuneError, 1, b)
		if c.spent+cost > c.limit {
			c.truncated = true
			break
		}
		c.buf.WriteByte(b)
		c.spent += cost
	}
	c.partial = nil
	return c.buf.String()
}

func (x Executor) bash(ctx context.Context, workspace string, raw json.RawMessage) (any, error) {
	var input bashInput
	if err := decodeInput(raw, &input); err != nil {
		return nil, err
	}
	if input.Command == "" {
		return nil, errorf(protocol.ErrInvalidInput, "command is required")
	}

	dir := workspace
	if input.Cwd != "" {
		resolved, err := resolvePath(workspace, input.Cwd)
		if err != nil {
			return nil, err
		}
		dir = resolved
	}

	timeout := defaultBashTimeout
	if input.TimeoutMs > 0 {
		timeout = min(time.Duration(input.TimeoutMs)*time.Millisecond, maxBashTimeout)
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, "/bin/sh", "-c", input.Command)
	cmd.Dir = dir
	// The worker's own credentials must never be visible to commands the
	// agent runs: a prompt-injected model could otherwise exfiltrate the
	// enrollment token with a single `env`.
	cmd.Env = sanitizedEnvironment()
	configureProcessGroup(cmd)
	stdout := &cappedBuffer{limit: maxStdoutBytes}
	stderr := &cappedBuffer{limit: maxStderrBytes}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.WaitDelay = 5 * time.Second

	started := time.Now()
	err := cmd.Run()
	duration := time.Since(started).Milliseconds()

	if runCtx.Err() != nil {
		return nil, errorf(protocol.ErrTimeout, "command timed out after %s", timeout)
	}

	exitCode := 0
	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			exitCode = exitError.ExitCode()
		} else {
			return nil, errorf(protocol.ErrExecution, "run command: %v", err)
		}
	}

	stdoutText := stdout.string()
	stderrText := stderr.string()
	return bashResult{
		Stdout:     stdoutText,
		Stderr:     stderrText,
		ExitCode:   exitCode,
		DurationMs: duration,
		Truncated:  stdout.truncated || stderr.truncated,
	}, nil
}
