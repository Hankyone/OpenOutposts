//go:build unix

package ops

import (
	"os/exec"
	"syscall"
)

// configureProcessGroup puts the shell in its own process group and kills the
// whole group on cancellation, so children spawned by the command cannot
// outlive a timeout.
func configureProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
