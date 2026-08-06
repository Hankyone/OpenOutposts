package update

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSwapInstallsAndKeepsThePreviousBinary(t *testing.T) {
	t.Parallel()

	installDir := t.TempDir()
	target := filepath.Join(installDir, "openoutpost")
	if err := os.WriteFile(target, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	verified := filepath.Join(t.TempDir(), "worker.bin")
	if err := os.WriteFile(verified, []byte("new binary"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := Swap(target, verified); err != nil {
		t.Fatal(err)
	}

	installed, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(installed) != "new binary" {
		t.Fatalf("installed content = %q", installed)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o755 {
		t.Fatalf("installed permissions = %o, want 755", got)
	}
	previous, err := os.ReadFile(OldPath(target))
	if err != nil {
		t.Fatal(err)
	}
	if string(previous) != "old binary" {
		t.Fatalf("previous binary content = %q", previous)
	}
	// The staging file must not be left behind next to the binary.
	if _, err := os.Stat(filepath.Join(installDir, stagedName)); !os.IsNotExist(err) {
		t.Fatal("the staged file was left in the install directory")
	}
}

func TestRestoreOldPutsThePreviousBinaryBack(t *testing.T) {
	t.Parallel()

	installDir := t.TempDir()
	target := filepath.Join(installDir, "openoutpost")
	if err := os.WriteFile(target, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	verified := filepath.Join(t.TempDir(), "worker.bin")
	if err := os.WriteFile(verified, []byte("new binary"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Swap(target, verified); err != nil {
		t.Fatal(err)
	}

	if err := RestoreOld(target); err != nil {
		t.Fatal(err)
	}
	restored, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != "old binary" {
		t.Fatalf("restored content = %q", restored)
	}
	if _, err := os.Stat(OldPath(target)); !os.IsNotExist(err) {
		t.Fatal("the previous binary should have been consumed by the restore")
	}
	if err := RestoreOld(target); err == nil {
		t.Fatal("restoring with nothing to restore should fail")
	}
}

func TestSwapLeavesAnUnwritableInstallationAlone(t *testing.T) {
	t.Parallel()

	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	if runtime.GOOS == "windows" {
		t.Skip("directory permissions do not gate renames on windows")
	}

	installDir := t.TempDir()
	target := filepath.Join(installDir, "openoutpost")
	if err := os.WriteFile(target, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	verified := filepath.Join(t.TempDir(), "worker.bin")
	if err := os.WriteFile(verified, []byte("new binary"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(installDir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(installDir, 0o700) })

	if err := DirWritable(installDir); err == nil {
		t.Fatal("expected the probe to report an unwritable directory")
	}
	if err := Swap(target, verified); err == nil {
		t.Fatal("expected the swap to fail")
	}
	if err := os.Chmod(installDir, 0o700); err != nil {
		t.Fatal(err)
	}
	installed, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(installed) != "old binary" {
		t.Fatalf("the installed binary changed: %q", installed)
	}
}

func TestDirWritableAcceptsAWritableDirectory(t *testing.T) {
	t.Parallel()

	if err := DirWritable(t.TempDir()); err != nil {
		t.Fatal(err)
	}
}
