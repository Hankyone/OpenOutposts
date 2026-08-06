package ops

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/protocol"
)

func TestGrepFailsOnAPathThatDoesNotExist(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()

	_, err := execute(t, workspace, "grep", map[string]any{
		"pattern": "needle",
		"path":    "no-such-directory",
	})
	requireOpsError(t, err, protocol.ErrExecution)
}

func TestGrepFailsOnARootItCannotRead(t *testing.T) {
	t.Parallel()
	if os.Geteuid() == 0 {
		t.Skip("root reads directories regardless of their mode")
	}
	workspace := t.TempDir()
	locked := filepath.Join(workspace, "locked")
	if err := os.Mkdir(locked, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(locked, "hit.txt"), []byte("needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	_, err := execute(t, workspace, "grep", map[string]any{"pattern": "needle", "path": "locked"})
	requireOpsError(t, err, protocol.ErrExecution)
}

func TestGrepSurvivesAnUnreadableSubdirectory(t *testing.T) {
	t.Parallel()
	if os.Geteuid() == 0 {
		t.Skip("root reads directories regardless of their mode")
	}
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "hit.txt"), []byte("needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	locked := filepath.Join(workspace, "locked")
	if err := os.Mkdir(locked, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	result, err := execute(t, workspace, "grep", map[string]any{"pattern": "needle"})
	if err != nil {
		t.Fatalf("one unreadable subdirectory must not fail the whole search: %v", err)
	}
	matches := result.(grepResult).Matches
	if len(matches) != 1 || matches[0].Path != "hit.txt" {
		t.Fatalf("unexpected matches: %+v", matches)
	}
}

func TestFindFailsWhenTheRootCannotBeRead(t *testing.T) {
	t.Parallel()
	if os.Geteuid() == 0 {
		t.Skip("root reads directories regardless of their mode")
	}
	workspace := t.TempDir()
	if err := os.Chmod(workspace, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(workspace, 0o755) })

	_, err := execute(t, workspace, "find", map[string]any{"glob": "**/*.go"})
	requireOpsError(t, err, protocol.ErrExecution)
}

// TestBashIsNotConfinedToTheWorkspace pins the behaviour the package comment
// describes. bash is deliberately unconfined: the boundary is the enrolled
// account, not the workspace. A change that appears to break this test is a
// change to the product's confinement model, not a bug fix.
func TestBashIsNotConfinedToTheWorkspace(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()
	outside := t.TempDir()
	reachable := filepath.Join(outside, "outside.txt")
	if err := os.WriteFile(reachable, []byte("reachable"), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := execute(t, workspace, "bash", map[string]any{
		"command": "cat '" + reachable + "'",
	})
	if err != nil {
		t.Fatal(err)
	}
	bash := result.(bashResult)
	if bash.ExitCode != 0 || bash.Stdout != "reachable" {
		t.Fatalf("bash confinement changed: exit=%d stdout=%q stderr=%q", bash.ExitCode, bash.Stdout, bash.Stderr)
	}

	// The same path through a bounded file operation is rejected, which is the
	// asymmetry the package comment now states.
	_, err = execute(t, workspace, "read", map[string]any{"path": reachable})
	requireOpsError(t, err, protocol.ErrPathOutsideWorkspace)
}
