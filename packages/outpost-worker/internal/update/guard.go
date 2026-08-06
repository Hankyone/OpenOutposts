package update

import (
	"errors"
	"log/slog"
)

// maxUpdateBootAttempts is how many starts a freshly installed binary gets to
// reach a successful registration before it is treated as broken. The count
// only advances on start-up, so a worker that runs for a week and then
// restarts has already been confirmed and is never rolled back.
const maxUpdateBootAttempts = 3

// RunStartupGuard is the crash-loop escape hatch. It runs before the worker
// tries to connect, and it is the reason a bad release cannot take a fleet
// offline: a binary that fails to register three times in a row is replaced by
// the one it displaced, which is still sitting next to it.
//
// Any failure here is reported and tolerated. This is update machinery, and no
// part of it may stop a worker from doing its job.
func RunStartupGuard(log *slog.Logger, stateDir, currentVersion string, execSelf func(string) error) error {
	// A staging directory left over from a killed update holds unverified
	// bytes. Nothing may read it, so it goes before anything else starts.
	if _, err := resetStaging(stateDir); err != nil {
		log.Warn("could not clear the update staging directory", "error", err)
	}

	state, err := LoadState(stateDir)
	if err != nil {
		return err
	}
	pending := state.Pending
	if pending == nil || pending.Confirmed {
		return nil
	}

	pending.BootAttempts++
	if err := SaveState(stateDir, state); err != nil {
		return err
	}
	if pending.BootAttempts <= maxUpdateBootAttempts {
		log.Info(
			"starting a freshly updated worker",
			"from_version", pending.FromVersion,
			"to_version", pending.ToVersion,
			"boot_attempt", pending.BootAttempts,
		)
		return nil
	}

	target, err := executableTarget()
	if err != nil {
		return err
	}
	log.Error(
		"rolling back a self-update that never registered",
		"from_version", pending.FromVersion,
		"to_version", pending.ToVersion,
		"boot_attempts", pending.BootAttempts,
	)
	if err := RestoreOld(target); err != nil {
		// Nothing to put back. Clear the pending record anyway so the worker
		// stops counting attempts against an update it can no longer undo.
		state.Pending = nil
		return errors.Join(err, SaveState(stateDir, state))
	}
	state.Pending = nil
	if err := SaveState(stateDir, state); err != nil {
		return err
	}
	if err := execSelf(target); err != nil {
		// Re-exec is how the restored binary takes over in place. Where that
		// is unavailable, exiting hands the job to the service manager.
		log.Error("could not re-exec the restored binary; exiting for the supervisor", "error", err)
		exitProcess(restartExitCode)
	}
	return nil
}
