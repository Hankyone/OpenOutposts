package ops

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"

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
)

// Overflowing this conversion is a compile error, so bash's two string
// budgets cannot exceed the shared encoded operation-output budget.
const _ = uint(protocol.MaxToolOutputBytes - maxStdoutBytes - maxStderrBytes)

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
