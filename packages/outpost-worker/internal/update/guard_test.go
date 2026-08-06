package update

import (
	"crypto/ed25519"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// installedPair writes a target binary and the .old the swap would have left,
// standing in for a machine that has just updated, and points the package's
// executable lookup at it. Tests using it must not call t.Parallel.
func installedPair(t *testing.T) string {
	t.Helper()
	installDir := t.TempDir()
	target := filepath.Join(installDir, "openoutpost")
	if err := os.WriteFile(target, []byte("new binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(OldPath(target), []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	previous := executableTarget
	executableTarget = func() (string, error) { return target, nil }
	t.Cleanup(func() { executableTarget = previous })
	return target
}

func pendingState(target string) State {
	return State{
		Version: stateVersion,
		Pending: &PendingUpdate{
			FromVersion:   "v1.0.0",
			ToVersion:     "v1.1.0",
			OldBinaryPath: OldPath(target),
			AppliedAt:     time.Now().UTC(),
		},
	}
}

func TestStartupGuardCountsBootsBeforeRollingBack(t *testing.T) {
	stateDir := t.TempDir()
	target := installedPair(t)
	if err := SaveState(stateDir, pendingState(target)); err != nil {
		t.Fatal(err)
	}

	execCalls := make([]string, 0, 1)
	execSelf := func(path string) error {
		execCalls = append(execCalls, path)
		return nil
	}

	for attempt := 1; attempt <= maxUpdateBootAttempts; attempt++ {
		if err := RunStartupGuard(discardLogger(), stateDir, "v1.1.0", execSelf); err != nil {
			t.Fatal(err)
		}
		state, err := LoadState(stateDir)
		if err != nil {
			t.Fatal(err)
		}
		if state.Pending == nil || state.Pending.BootAttempts != attempt {
			t.Fatalf("boot attempts = %#v, want %d", state.Pending, attempt)
		}
		if len(execCalls) != 0 {
			t.Fatal("the guard rolled back before the attempt limit")
		}
	}

	if err := RunStartupGuard(discardLogger(), stateDir, "v1.1.0", execSelf); err != nil {
		t.Fatal(err)
	}
	if len(execCalls) != 1 || execCalls[0] != target {
		t.Fatalf("expected one re-exec of %s, got %v", target, execCalls)
	}
	restored, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != "old binary" {
		t.Fatalf("the previous binary was not restored: %q", restored)
	}
	state, err := LoadState(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if state.Pending != nil {
		t.Fatalf("pending update was not cleared: %#v", state.Pending)
	}
}

func TestStartupGuardIsANoOpWithoutAPendingUpdate(t *testing.T) {
	t.Parallel()

	stateDir := t.TempDir()
	called := false
	if err := RunStartupGuard(discardLogger(), stateDir, "v1.1.0", func(string) error {
		called = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if called {
		t.Fatal("the guard re-executed with nothing pending")
	}
}

// A staging directory left behind by a killed update holds unverified bytes.
func TestStartupGuardClearsStaging(t *testing.T) {
	t.Parallel()

	stateDir := t.TempDir()
	staging := StagingDir(stateDir)
	if err := os.MkdirAll(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	leftover := filepath.Join(staging, "half-downloaded.bin")
	if err := os.WriteFile(leftover, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := RunStartupGuard(discardLogger(), stateDir, "v1.1.0", func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(leftover); !os.IsNotExist(err) {
		t.Fatal("leftover staging content survived start-up")
	}
}

func TestConfirmIfPendingClearsTheRollback(t *testing.T) {
	stateDir := t.TempDir()
	target := installedPair(t)
	if err := SaveState(stateDir, pendingState(target)); err != nil {
		t.Fatal(err)
	}

	public, _ := testKey(t, 20)
	updater, err := New(Options{
		StateDir:       stateDir,
		BaseURL:        "https://releases.example.com/releases/",
		CurrentVersion: "v1.1.0",
		ExecSelf:       func(string) error { return nil },
		Log:            discardLogger(),
		Keys:           []ed25519.PublicKey{public},
	})
	if err != nil {
		t.Fatal(err)
	}
	updater.ConfirmIfPending()
	updater.ConfirmIfPending()

	state, err := LoadState(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if state.Pending != nil {
		t.Fatalf("pending update survived confirmation: %#v", state.Pending)
	}
	if _, err := os.Stat(OldPath(target)); !os.IsNotExist(err) {
		t.Fatal("the previous binary was not removed")
	}
}

func TestConfirmIfPendingLeavesMismatchedUpdateUntouched(t *testing.T) {
	stateDir := t.TempDir()
	target := installedPair(t)
	expected := pendingState(target)
	if err := SaveState(stateDir, expected); err != nil {
		t.Fatal(err)
	}

	public, _ := testKey(t, 20)
	updater, err := New(Options{
		StateDir:       stateDir,
		BaseURL:        "https://releases.example.com/releases/",
		CurrentVersion: "v1.0.0",
		ExecSelf:       func(string) error { return nil },
		Log:            discardLogger(),
		Keys:           []ed25519.PublicKey{public},
	})
	if err != nil {
		t.Fatal(err)
	}
	updater.ConfirmIfPending()

	state, err := LoadState(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if state.Pending == nil {
		t.Fatal("mismatched pending update was cleared")
	}
	if got, want := *state.Pending, *expected.Pending; got != want {
		t.Fatalf("pending update changed: got %#v, want %#v", got, want)
	}
	rollback, err := os.ReadFile(OldPath(target))
	if err != nil {
		t.Fatal(err)
	}
	if string(rollback) != "old binary" {
		t.Fatalf("the previous binary changed: %q", rollback)
	}
}

func TestUpdateLockExcludesLiveOwner(t *testing.T) {
	t.Parallel()

	stateDir := t.TempDir()
	held, err := AcquireLock(stateDir, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireLock(stateDir, time.Hour); err != ErrLocked {
		t.Fatalf("expected the lock to be held, got %v", err)
	}
	if err := held.Release(); err != nil {
		t.Fatal(err)
	}
	reacquired, err := AcquireLock(stateDir, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := reacquired.Release(); err != nil {
		t.Fatal(err)
	}
	if err := reacquired.Release(); err != nil {
		t.Fatalf("release was not idempotent: %v", err)
	}
}

func TestUpdateLockHeartbeatKeepsLeaseLive(t *testing.T) {
	t.Parallel()

	stateDir := t.TempDir()
	staleAfter := 20 * time.Millisecond
	held, err := AcquireLock(stateDir, staleAfter)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = held.Release() }()
	ownerBefore, err := os.Stat(held.ownerPath)
	if err != nil {
		t.Fatal(err)
	}
	directoryBefore, err := os.Stat(held.path)
	if err != nil {
		t.Fatal(err)
	}

	for range 4 {
		time.Sleep(staleAfter / 2)
		if err := held.Heartbeat(); err != nil {
			t.Fatal(err)
		}
	}
	ownerAfter, err := os.Stat(held.ownerPath)
	if err != nil {
		t.Fatal(err)
	}
	directoryAfter, err := os.Stat(held.path)
	if err != nil {
		t.Fatal(err)
	}
	if !ownerAfter.ModTime().After(ownerBefore.ModTime()) {
		t.Fatal("heartbeat did not refresh the owner marker")
	}
	if !directoryAfter.ModTime().After(directoryBefore.ModTime()) {
		t.Fatal("heartbeat did not refresh the lock directory")
	}
	if _, err := AcquireLock(stateDir, staleAfter); !errors.Is(err, ErrLocked) {
		t.Fatalf("heartbeat did not keep the lock live: %v", err)
	}
}

func TestUpdateLockReclaimsAbandonedOwner(t *testing.T) {
	t.Parallel()

	stateDir := t.TempDir()
	abandoned, err := AcquireLock(stateDir, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(abandoned.ownerPath, old, old); err != nil {
		t.Fatal(err)
	}
	replacement, err := AcquireLock(stateDir, time.Hour)
	if err != nil {
		t.Fatalf("expected a stale lock to be reclaimed, got %v", err)
	}
	if err := replacement.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateLockHeartbeatRacingTakeoverIsSafe(t *testing.T) {
	t.Parallel()

	stateDir := t.TempDir()
	held, err := AcquireLock(stateDir, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(held.ownerPath, old, old); err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	heartbeatResult := make(chan error, 1)
	acquireResult := make(chan struct {
		lock *Lock
		err  error
	}, 1)
	go func() {
		<-start
		heartbeatResult <- held.Heartbeat()
	}()
	go func() {
		<-start
		lock, err := AcquireLock(stateDir, time.Hour)
		acquireResult <- struct {
			lock *Lock
			err  error
		}{lock: lock, err: err}
	}()
	close(start)

	heartbeatErr := <-heartbeatResult
	acquired := <-acquireResult
	switch {
	case acquired.err == nil:
		if !errors.Is(heartbeatErr, ErrLockOwnershipLost) {
			t.Fatalf("takeover succeeded but heartbeat returned %v", heartbeatErr)
		}
		if err := acquired.lock.Release(); err != nil {
			t.Fatal(err)
		}
	case errors.Is(acquired.err, ErrLocked):
		if heartbeatErr != nil && !errors.Is(heartbeatErr, ErrLockOwnershipLost) {
			t.Fatalf("takeover stopped with unexpected heartbeat error %v", heartbeatErr)
		}
		if err := held.Release(); err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatalf("unexpected takeover result: %v", acquired.err)
	}
}

func TestUpdateLockOldOwnerCannotReleaseSuccessor(t *testing.T) {
	t.Parallel()

	stateDir := t.TempDir()
	oldOwner, err := AcquireLock(stateDir, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(oldOwner.ownerPath, old, old); err != nil {
		t.Fatal(err)
	}
	successor, err := AcquireLock(stateDir, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := oldOwner.Release(); !errors.Is(err, ErrLockOwnershipLost) {
		t.Fatalf("old owner release = %v, want ownership lost", err)
	}
	if _, err := AcquireLock(stateDir, time.Hour); !errors.Is(err, ErrLocked) {
		t.Fatalf("successor lock was removed: %v", err)
	}
	if err := successor.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateLockSerializesConcurrentReclaimers(t *testing.T) {
	t.Parallel()

	stateDir := t.TempDir()
	abandoned, err := AcquireLock(stateDir, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(abandoned.ownerPath, old, old); err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	results := make(chan struct {
		lock *Lock
		err  error
	}, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for range 2 {
		go func() {
			ready.Done()
			<-start
			lock, err := AcquireLock(stateDir, time.Hour)
			results <- struct {
				lock *Lock
				err  error
			}{lock: lock, err: err}
		}()
	}
	ready.Wait()
	close(start)

	var winner *Lock
	locked := 0
	for range 2 {
		result := <-results
		if result.err == nil {
			if winner != nil {
				t.Fatal("two reclaimers acquired the update lock")
			}
			winner = result.lock
		} else if errors.Is(result.err, ErrLocked) {
			locked++
		} else {
			t.Fatalf("unexpected reclaimer error: %v", result.err)
		}
	}
	if winner == nil || locked != 1 {
		t.Fatalf("winner = %v, locked losers = %d", winner != nil, locked)
	}
	if _, err := AcquireLock(stateDir, time.Hour); !errors.Is(err, ErrLocked) {
		t.Fatalf("winner was not exclusive: %v", err)
	}
	if err := winner.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateLockSupportsLegacyLockFiles(t *testing.T) {
	t.Parallel()

	stateDir := t.TempDir()
	lockPath := filepath.Join(stateDir, lockFileName)
	if err := os.WriteFile(lockPath, []byte("123 2026-01-01T00:00:00Z\n"), stateFilePerm); err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireLock(stateDir, time.Hour); !errors.Is(err, ErrLocked) {
		t.Fatalf("fresh legacy lock was not respected: %v", err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(lockPath, old, old); err != nil {
		t.Fatal(err)
	}
	replacement, err := AcquireLock(stateDir, time.Hour)
	if err != nil {
		t.Fatalf("stale legacy lock was not reclaimed: %v", err)
	}
	if err := replacement.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateLockReclaimsStaleMalformedDirectory(t *testing.T) {
	t.Parallel()

	stateDir := t.TempDir()
	lockPath := filepath.Join(stateDir, lockFileName)
	if err := os.Mkdir(lockPath, stateDirFilePerm); err != nil {
		t.Fatal(err)
	}
	malformed := filepath.Join(lockPath, "not-an-owner")
	if err := os.WriteFile(malformed, []byte("abandoned"), stateFilePerm); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(lockPath, old, old); err != nil {
		t.Fatal(err)
	}
	replacement, err := AcquireLock(stateDir, time.Hour)
	if err != nil {
		t.Fatalf("stale malformed lock was not reclaimed: %v", err)
	}
	if err := replacement.Release(); err != nil {
		t.Fatal(err)
	}
}
