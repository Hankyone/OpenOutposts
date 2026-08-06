// Package ops implements the bounded tool operations a worker exposes to the
// control plane.
//
// The path-taking operations — read, write, edit, grep, find and ls — are
// confined to the workspace path of the lease they run under; escaping the
// workspace, including through symlinks, is rejected with
// path_outside_workspace.
//
// bash is not confined. It runs /bin/sh with its working directory set to the
// leased workspace, but the shell keeps the reach of the operating-system
// account the worker runs as, so a command may read and write anything that
// account may. That is the deliberate product boundary described under the
// README's confinement model: the operator chooses which account and machine
// to enrol, and workspace roots constrain leases and the bounded file tools
// rather than the shell. Every operation's output is bounded, and the worker's
// own credentials are stripped from the command environment.
package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/protocol"
)

// Error carries a protocol tool error code alongside the message.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func errorf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

var Operations = []string{"bash", "read", "write", "edit", "grep", "find", "ls"}

type Executor struct{}

// Execute runs one operation inside the given workspace. The returned error,
// when non-nil, is always an *Error with a protocol error code.
func (x Executor) Execute(ctx context.Context, workspace, operation string, input json.RawMessage) (any, error) {
	switch operation {
	case "bash":
		return x.bash(ctx, workspace, input)
	case "read":
		return x.read(workspace, input)
	case "write":
		return x.write(workspace, input)
	case "edit":
		return x.edit(workspace, input)
	case "grep":
		return x.grep(ctx, workspace, input)
	case "find":
		return x.find(ctx, workspace, input)
	case "ls":
		return x.ls(workspace, input)
	default:
		return nil, errorf(protocol.ErrOperationUnsupported, "operation %q is not supported", operation)
	}
}

func decodeInput(input json.RawMessage, target any) error {
	decoder := json.NewDecoder(strings.NewReader(string(input)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return errorf(protocol.ErrInvalidInput, "invalid input: %v", err)
	}
	return nil
}

// resolvePath maps a workspace-relative path onto the filesystem and verifies
// the result stays inside the workspace after resolving symlinks. When the
// target does not exist yet (writes), its deepest existing ancestor is
// resolved instead.
func resolvePath(workspace, rel string) (string, error) {
	if rel == "" || rel == "." {
		rel = "."
	}
	if filepath.IsAbs(rel) {
		return "", errorf(protocol.ErrPathOutsideWorkspace, "path %q must be workspace-relative", rel)
	}
	cleaned := filepath.Clean(rel)
	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", errorf(protocol.ErrPathOutsideWorkspace, "path %q escapes the workspace", rel)
	}

	workspaceReal, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return "", errorf(protocol.ErrExecution, "workspace is not accessible: %v", err)
	}

	target := filepath.Join(workspaceReal, cleaned)
	resolved, err := resolveExistingPrefix(target)
	if err != nil {
		return "", errorf(protocol.ErrExecution, "resolve path %q: %v", rel, err)
	}
	if resolved != workspaceReal && !strings.HasPrefix(resolved, workspaceReal+string(filepath.Separator)) {
		return "", errorf(protocol.ErrPathOutsideWorkspace, "path %q escapes the workspace", rel)
	}
	return target, nil
}

// resolveExistingPrefix evaluates symlinks over the deepest existing ancestor
// of target and re-appends the non-existing remainder.
func resolveExistingPrefix(target string) (string, error) {
	existing := target
	var remainder []string
	for {
		resolved, err := filepath.EvalSymlinks(existing)
		if err == nil {
			return filepath.Join(append([]string{resolved}, remainder...)...), nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			return "", err
		}
		remainder = append([]string{filepath.Base(existing)}, remainder...)
		existing = parent
	}
}
