package ops

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/protocol"
)

func execute(t *testing.T, workspace, operation string, input any) (any, error) {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return Executor{}.Execute(context.Background(), workspace, operation, raw)
}

func requireOpsError(t *testing.T, err error, code string) {
	t.Helper()
	var opError *Error
	if !errors.As(err, &opError) {
		t.Fatalf("expected ops error, got %v", err)
	}
	if opError.Code != code {
		t.Fatalf("expected error code %q, got %q (%s)", code, opError.Code, opError.Message)
	}
}

func TestPathConfinement(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()

	_, err := execute(t, workspace, "read", map[string]any{"path": "/etc/passwd"})
	requireOpsError(t, err, protocol.ErrPathOutsideWorkspace)

	_, err = execute(t, workspace, "read", map[string]any{"path": "../outside.txt"})
	requireOpsError(t, err, protocol.ErrPathOutsideWorkspace)

	_, err = execute(t, workspace, "write", map[string]any{"path": "a/../../escape.txt", "content": "x"})
	requireOpsError(t, err, protocol.ErrPathOutsideWorkspace)
}

func TestSymlinkEscapeIsRejected(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(workspace, "link")); err != nil {
		t.Fatal(err)
	}

	_, err := execute(t, workspace, "read", map[string]any{"path": "link/secret.txt"})
	requireOpsError(t, err, protocol.ErrPathOutsideWorkspace)
}

func TestWriteThroughDanglingSymlinkIsRejected(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()
	outside := t.TempDir()
	// The link's destination does not exist, so only the workspace-resident
	// ancestors of the leaf resolve — the classic escape for file creation.
	if err := os.Symlink(filepath.Join(outside, "planted.txt"), filepath.Join(workspace, "link")); err != nil {
		t.Fatal(err)
	}

	_, err := execute(t, workspace, "write", map[string]any{"path": "link", "content": "x"})
	requireOpsError(t, err, protocol.ErrPathOutsideWorkspace)

	if _, statErr := os.Stat(filepath.Join(outside, "planted.txt")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatal("write escaped the workspace through a dangling symlink")
	}
}

func TestBashDoesNotSeeWorkerCredentials(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("OPENOUTPOSTS_TOKEN", "super-secret-enrollment-token")
	t.Setenv("OPENOUTPOSTS_CONTROL_PLANE_URL", "https://control.example")

	result, err := execute(t, workspace, "bash", map[string]any{
		"command": `printf "%s" "[$OPENOUTPOSTS_TOKEN][$OPENOUTPOSTS_CONTROL_PLANE_URL]"`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := result.(bashResult).Stdout; got != "[][]" {
		t.Fatalf("worker credentials leaked into the command environment: %q", got)
	}
}

func TestWriteReadEditRoundtrip(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()

	written, err := execute(t, workspace, "write", map[string]any{
		"path":    "nested/dir/hello.txt",
		"content": "hello outpost\nsecond line\n",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !written.(writeResult).Created {
		t.Fatal("expected file to be reported as created")
	}

	read, err := execute(t, workspace, "read", map[string]any{"path": "nested/dir/hello.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if read.(readResult).Content != "hello outpost\nsecond line\n" {
		t.Fatalf("unexpected content: %q", read.(readResult).Content)
	}

	edited, err := execute(t, workspace, "edit", map[string]any{
		"path":      "nested/dir/hello.txt",
		"oldString": "hello outpost",
		"newString": "hello world",
	})
	if err != nil {
		t.Fatal(err)
	}
	if edited.(editResult).Replacements != 1 {
		t.Fatalf("expected 1 replacement, got %d", edited.(editResult).Replacements)
	}

	_, err = execute(t, workspace, "edit", map[string]any{
		"path":      "nested/dir/hello.txt",
		"oldString": "absent string",
		"newString": "row",
	})
	requireOpsError(t, err, protocol.ErrExecution)

	_, err = execute(t, workspace, "edit", map[string]any{
		"path":      "nested/dir/hello.txt",
		"oldString": "l",
		"newString": "L",
	})
	requireOpsError(t, err, protocol.ErrExecution)
}

func TestEditAmbiguityRequiresReplaceAll(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "a.txt"), []byte("x x x"), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := execute(t, workspace, "edit", map[string]any{
		"path":       "a.txt",
		"oldString":  "x",
		"newString":  "y",
		"replaceAll": true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.(editResult).Replacements != 3 {
		t.Fatalf("expected 3 replacements, got %d", result.(editResult).Replacements)
	}
}

func TestBashRunsInWorkspace(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()

	result, err := execute(t, workspace, "bash", map[string]any{"command": "pwd -P && echo done"})
	if err != nil {
		t.Fatal(err)
	}
	bash := result.(bashResult)
	if bash.ExitCode != 0 {
		t.Fatalf("unexpected exit code %d: %s", bash.ExitCode, bash.Stderr)
	}
	resolved, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		t.Fatal(err)
	}
	if got := bash.Stdout; got != resolved+"\ndone\n" {
		t.Fatalf("unexpected stdout: %q", got)
	}
}

func TestBashReportsExitCodeAndTimeout(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()

	result, err := execute(t, workspace, "bash", map[string]any{"command": "exit 3"})
	if err != nil {
		t.Fatal(err)
	}
	if result.(bashResult).ExitCode != 3 {
		t.Fatalf("expected exit code 3, got %d", result.(bashResult).ExitCode)
	}

	_, err = execute(t, workspace, "bash", map[string]any{"command": "sleep 5", "timeoutMs": 100})
	requireOpsError(t, err, protocol.ErrTimeout)
}

func TestGrepAndFind(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workspace, "src", ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"src/main.go":        "package main\nfunc main() {}\n",
		"src/util.go":        "package main\nfunc helper() {}\n",
		"src/.git/config":    "func hidden() {}\n",
		"docs/readme.md":     "no functions here\n",
		"src/nested/deep.go": "func deep() {}\n",
	}
	for path, content := range files {
		full := filepath.Join(workspace, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	grepOut, err := execute(t, workspace, "grep", map[string]any{"pattern": `func \w+\(`})
	if err != nil {
		t.Fatal(err)
	}
	matches := grepOut.(grepResult).Matches
	if len(matches) != 3 {
		t.Fatalf("expected 3 matches, got %d: %+v", len(matches), matches)
	}
	for _, match := range matches {
		if match.Path == "src/.git/config" {
			t.Fatal("grep must skip .git")
		}
	}

	scoped, err := execute(t, workspace, "grep", map[string]any{"pattern": "func", "path": "src/nested"})
	if err != nil {
		t.Fatal(err)
	}
	scopedMatches := scoped.(grepResult).Matches
	if len(scopedMatches) != 1 || scopedMatches[0].Path != "src/nested/deep.go" {
		t.Fatalf("unexpected scoped matches: %+v", scopedMatches)
	}

	found, err := execute(t, workspace, "find", map[string]any{"glob": "**/*.go"})
	if err != nil {
		t.Fatal(err)
	}
	if paths := found.(findResult).Paths; len(paths) != 3 {
		t.Fatalf("expected 3 go files, got %v", paths)
	}

	basename, err := execute(t, workspace, "find", map[string]any{"glob": "readme.md"})
	if err != nil {
		t.Fatal(err)
	}
	if paths := basename.(findResult).Paths; len(paths) != 1 || paths[0] != "docs/readme.md" {
		t.Fatalf("unexpected basename find: %v", paths)
	}
}

func TestLs(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workspace, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "file.txt"), []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := execute(t, workspace, "ls", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	entries := result.(lsResult).Entries
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %+v", entries)
	}
	if entries[0].Name != "file.txt" || entries[0].Type != "file" || entries[0].SizeBytes == nil || *entries[0].SizeBytes != 4 {
		t.Fatalf("unexpected file entry: %+v", entries[0])
	}
	if entries[1].Name != "sub" || entries[1].Type != "dir" {
		t.Fatalf("unexpected dir entry: %+v", entries[1])
	}
}

func TestUnknownOperationAndInput(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()

	_, err := execute(t, workspace, "rsync", map[string]any{})
	requireOpsError(t, err, protocol.ErrOperationUnsupported)

	_, err = execute(t, workspace, "read", map[string]any{"path": "a.txt", "bogus": true})
	requireOpsError(t, err, protocol.ErrInvalidInput)
}
