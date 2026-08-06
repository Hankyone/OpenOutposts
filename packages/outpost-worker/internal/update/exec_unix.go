//go:build unix

package update

import (
	"fmt"
	"os"
	"syscall"
)

// ExecSelf replaces this process image with the binary at path, keeping the
// process ID, the arguments and the environment. A service manager sees no
// exit at all, and a worker started by hand in a terminal keeps its terminal.
// It only returns on failure.
func ExecSelf(path string) error {
	arguments := append([]string{path}, os.Args[1:]...)
	if err := syscall.Exec(path, arguments, os.Environ()); err != nil {
		return fmt.Errorf("re-exec %s: %w", path, err)
	}
	return nil
}
