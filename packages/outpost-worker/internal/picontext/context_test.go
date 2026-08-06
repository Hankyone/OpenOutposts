package picontext

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiscoverOrdersContextFromRootToWorkspace(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	workspace := filepath.Join(root, "sessions", "one")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(path, content string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(root, "AGENTS.md"), "root")
	write(filepath.Join(root, "sessions", "CLAUDE.md"), "sessions")
	write(filepath.Join(workspace, "AGENTS.md"), "workspace")
	write(filepath.Join(workspace, "CLAUDE.md"), "shadowed")

	files, warnings, err := Discover(root, workspace)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v", warnings)
	}
	want := []File{
		{Path: "outpost:/AGENTS.md", Content: "root"},
		{Path: "outpost:/sessions/CLAUDE.md", Content: "sessions"},
		{Path: "outpost:/sessions/one/AGENTS.md", Content: "workspace"},
	}
	if len(files) != len(want) {
		t.Fatalf("files = %#v", files)
	}
	for index := range want {
		if files[index] != want[index] {
			t.Fatalf("files[%d] = %#v, want %#v", index, files[index], want[index])
		}
	}
}

func TestDiscoverDoesNotReadASymlinkOutsideTheRoot(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.md")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "AGENTS.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "CLAUDE.md"), []byte("safe"), 0o600); err != nil {
		t.Fatal(err)
	}

	files, warnings, err := Discover(root, root)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) == 0 {
		t.Fatalf("warnings = %v", warnings)
	}
	if len(files) != 1 || files[0].Content != "safe" {
		t.Fatalf("files = %#v", files)
	}
}

func TestDiscoverRejectsContextOverTheWireBudget(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(root, "AGENTS.md"),
		[]byte(strings.Repeat("x", MaxBytes+1)),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	if _, _, err := Discover(root, root); err == nil {
		t.Fatal("expected oversized context to be rejected")
	}
}

func TestDiscoverRejectsAWorkspaceOutsideTheRoot(t *testing.T) {
	t.Parallel()

	if _, _, err := Discover(t.TempDir(), t.TempDir()); err == nil {
		t.Fatal("expected an out-of-root workspace to be rejected")
	}
}
