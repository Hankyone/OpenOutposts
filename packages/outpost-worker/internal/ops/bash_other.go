//go:build !unix

package ops

import "os/exec"

// On non-unix platforms cancellation falls back to killing only the direct
// child process.
func configureProcessGroup(_ *exec.Cmd) {}
