//go:build !unix

package update

// ExecSelf cannot replace a running process on this platform. The caller exits
// with restartExitCode instead and lets the service manager start the new
// binary.
func ExecSelf(string) error {
	return ErrExecUnsupported
}
