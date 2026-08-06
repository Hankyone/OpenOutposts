package update

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// stagedName is the temporary file the new binary lands on next to the
// installed one. Same directory, therefore same filesystem, therefore the
// install is a rename rather than a copy that could be interrupted halfway.
const stagedName = ".openoutpost.new"

// executableTarget is ExecutableTarget, indirected so tests can point the
// installer at a scratch file rather than at the running test binary.
var executableTarget = ExecutableTarget

// ExecutableTarget is the path this process would replace: the running
// executable with symlinks resolved, so a `/usr/local/bin/openoutpost`
// symlink is followed to the real file instead of being overwritten by it.
func ExecutableTarget() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("locate this executable: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return "", fmt.Errorf("resolve this executable: %w", err)
	}
	return resolved, nil
}

// OldPath is where Swap parks the binary it replaced, kept until the new one
// proves it can connect.
func OldPath(target string) string {
	return target + ".old"
}

// DirWritable probes the directory by creating and removing a file. An
// installation the service user cannot write is the common case that makes
// self-update impossible, and it is worth reporting before anything is
// downloaded.
func DirWritable(dir string) error {
	probe, err := os.CreateTemp(dir, ".openoutpost-probe-*")
	if err != nil {
		return fmt.Errorf("install directory %s is not writable: %w", dir, err)
	}
	name := probe.Name()
	closeErr := probe.Close()
	removeErr := os.Remove(name)
	return errors.Join(closeErr, removeErr)
}

// Swap installs a verified binary over the running one. The old binary is kept
// beside the new one so a worker that cannot start can be put back.
//
// The order matters: the replacement is fully written and flushed before
// anything is renamed, and the target only stops existing for the instant
// between the two renames. If the second rename fails, the first is undone.
func Swap(target, verified string) error {
	directory := filepath.Dir(target)
	stagedPath := filepath.Join(directory, stagedName)

	if err := copyExecutable(verified, stagedPath); err != nil {
		_ = os.Remove(stagedPath)
		return err
	}

	oldPath := OldPath(target)
	_ = os.Remove(oldPath)
	if err := os.Rename(target, oldPath); err != nil {
		_ = os.Remove(stagedPath)
		return fmt.Errorf("move the installed binary aside: %w", err)
	}
	if err := os.Rename(stagedPath, target); err != nil {
		// Nothing is installed at this instant. Put the old binary back
		// before returning, or a restart finds no executable at all.
		if restoreErr := os.Rename(oldPath, target); restoreErr != nil {
			return fmt.Errorf(
				"install the new binary: %w (and restoring the previous binary failed: %v)",
				err, restoreErr,
			)
		}
		_ = os.Remove(stagedPath)
		return fmt.Errorf("install the new binary: %w", err)
	}
	syncDir(directory)
	return nil
}

// RestoreOld puts the previous binary back over the installed one. Used by the
// startup guard when a freshly installed worker cannot get on its feet.
func RestoreOld(target string) error {
	oldPath := OldPath(target)
	if _, err := os.Stat(oldPath); err != nil {
		return fmt.Errorf("no previous binary to restore: %w", err)
	}
	if err := os.Rename(oldPath, target); err != nil {
		return fmt.Errorf("restore the previous binary: %w", err)
	}
	syncDir(filepath.Dir(target))
	return nil
}

func copyExecutable(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("open the verified binary: %w", err)
	}
	defer input.Close()

	output, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return fmt.Errorf("create the staged binary: %w", err)
	}
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		return fmt.Errorf("write the staged binary: %w", err)
	}
	// The umask may have cleared the execute bits on create.
	if err := output.Chmod(0o755); err != nil {
		output.Close()
		return fmt.Errorf("make the staged binary executable: %w", err)
	}
	if err := output.Sync(); err != nil {
		output.Close()
		return fmt.Errorf("flush the staged binary: %w", err)
	}
	if err := output.Close(); err != nil {
		return fmt.Errorf("close the staged binary: %w", err)
	}
	return nil
}

// syncDir flushes the directory entry so the rename survives a power loss.
// Directories cannot be opened for writing on every platform, so a failure
// here is not fatal to an install that has already succeeded.
func syncDir(directory string) {
	handle, err := os.Open(directory)
	if err != nil {
		return
	}
	_ = handle.Sync()
	_ = handle.Close()
}
