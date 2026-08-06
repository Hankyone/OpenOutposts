package update

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	stateFileName    = "update-state.json"
	lockFileName     = "update.lock"
	stateVersion     = 1
	stagingDirName   = "update-staging"
	lockStaleAfter   = 30 * time.Minute
	stateFilePerm    = 0o600
	stateDirFilePerm = 0o700
	lockTokenBytes   = 16
	lockOwnerPrefix  = "owner-"
	lockReclaimName  = "reclaim"
)

// ErrLocked means another process is already inside an update cycle.
var ErrLocked = errors.New("another update is already in progress")

// ErrLockOwnershipLost means a lock's owner marker was removed by a stale
// takeover. The former owner must not perform any more protected work.
var ErrLockOwnershipLost = errors.New("update lock ownership was lost")

// PendingUpdate records a swap that has happened but has not yet been proven
// good. It is the only reason the previous binary is still on disk.
type PendingUpdate struct {
	FromVersion   string    `json:"fromVersion"`
	ToVersion     string    `json:"toVersion"`
	OldBinaryPath string    `json:"oldBinaryPath"`
	AppliedAt     time.Time `json:"appliedAt"`
	// BootAttempts counts starts since the swap that have not reached a
	// successful registration. It is what turns a crash loop into a rollback.
	BootAttempts int  `json:"bootAttempts"`
	Confirmed    bool `json:"confirmed"`
}

// State is the updater's durable memory.
type State struct {
	// Version is this file's schema version, matching the identity file's
	// convention.
	Version int `json:"version"`
	// LastSeenGeneratedAt is the newest manifest timestamp this worker has
	// accepted. An older one is refused, which is what stops a captured older
	// manifest from being replayed to walk a fleet backwards onto a build
	// whose bugs are known.
	LastSeenGeneratedAt time.Time      `json:"lastSeenGeneratedAt"`
	Pending             *PendingUpdate `json:"pending,omitempty"`
}

// StatePath is the update state file inside a worker's state directory.
func StatePath(stateDir string) string {
	return filepath.Join(stateDir, stateFileName)
}

// StagingDir is where downloads and patch intermediates are assembled. It is
// wiped at process start and at the start of every check, so a killed update
// never leaves bytes that a later one might trust.
func StagingDir(stateDir string) string {
	return filepath.Join(stateDir, stagingDirName)
}

// LoadState reads the update state. A missing file is a valid empty state; a
// corrupt one is an error, because silently starting from zero would drop the
// rollback protection this file exists to provide.
func LoadState(stateDir string) (State, error) {
	content, err := os.ReadFile(StatePath(stateDir))
	if errors.Is(err, os.ErrNotExist) {
		return State{Version: stateVersion}, nil
	}
	if err != nil {
		return State{}, fmt.Errorf("read update state: %w", err)
	}
	var state State
	if err := json.Unmarshal(content, &state); err != nil {
		return State{}, fmt.Errorf("decode update state: %w", err)
	}
	if state.Version != stateVersion {
		return State{}, fmt.Errorf("update state version %d is not supported", state.Version)
	}
	return state, nil
}

// SaveState writes the update state atomically, using the same temp-and-rename
// pattern as the identity file.
func SaveState(stateDir string, state State) error {
	state.Version = stateVersion
	if err := os.MkdirAll(stateDir, stateDirFilePerm); err != nil {
		return fmt.Errorf("create state directory: %w", err)
	}
	content, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("encode update state: %w", err)
	}
	temporary, err := os.CreateTemp(stateDir, ".update-state-*.tmp")
	if err != nil {
		return fmt.Errorf("create update state file: %w", err)
	}
	temporaryName := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryName)
	}
	if err := temporary.Chmod(stateFilePerm); err != nil {
		cleanup()
		return fmt.Errorf("secure update state file: %w", err)
	}
	if _, err := temporary.Write(content); err != nil {
		cleanup()
		return fmt.Errorf("write update state file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("sync update state file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		cleanup()
		return fmt.Errorf("close update state file: %w", err)
	}
	if err := os.Rename(temporaryName, StatePath(stateDir)); err != nil {
		cleanup()
		return fmt.Errorf("install update state file: %w", err)
	}
	return nil
}

// Lock is the exclusive right to run an update cycle. The daemon holds one
// while it checks and swaps; `openoutpost update` takes the same one, so a
// manual run and the background loop cannot both be replacing the binary.
type Lock struct {
	path      string
	ownerPath string
	mutex     sync.Mutex
	released  bool
}

// AcquireLock takes the update lock, reclaiming one left behind by a process
// that died mid-update. Without the staleness takeover a single crash would
// disable updates on that machine forever.
func AcquireLock(stateDir string, staleAfter time.Duration) (*Lock, error) {
	if err := os.MkdirAll(stateDir, stateDirFilePerm); err != nil {
		return nil, fmt.Errorf("create state directory: %w", err)
	}
	path := filepath.Join(stateDir, lockFileName)
	for attempt := 0; attempt < 3; attempt++ {
		err := os.Mkdir(path, stateDirFilePerm)
		if err == nil {
			lock, createErr := createLockOwner(path)
			if createErr != nil {
				_ = os.Remove(path)
				return nil, createErr
			}
			return lock, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("take update lock: %w", err)
		}
		info, statErr := os.Lstat(path)
		if errors.Is(statErr, os.ErrNotExist) {
			continue
		}
		if statErr != nil {
			return nil, ErrLocked
		}
		if !info.IsDir() {
			if time.Since(info.ModTime()) < staleAfter {
				return nil, ErrLocked
			}
			current, currentErr := os.Lstat(path)
			if currentErr != nil || !os.SameFile(info, current) {
				return nil, ErrLocked
			}
			if removeErr := os.Remove(path); removeErr != nil {
				return nil, ErrLocked
			}
			continue
		}
		reclaimed, reclaimErr := reclaimLockDirectory(path, info, staleAfter)
		if reclaimErr != nil {
			return nil, reclaimErr
		}
		if !reclaimed {
			return nil, ErrLocked
		}
	}
	return nil, ErrLocked
}

func createLockOwner(path string) (*Lock, error) {
	token := make([]byte, lockTokenBytes)
	if _, err := rand.Read(token); err != nil {
		return nil, fmt.Errorf("generate update lock owner: %w", err)
	}
	ownerPath := filepath.Join(path, lockOwnerPrefix+hex.EncodeToString(token))
	file, err := os.OpenFile(ownerPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, stateFilePerm)
	if err != nil {
		return nil, fmt.Errorf("create update lock owner: %w", err)
	}
	now := time.Now().UTC()
	if _, err := fmt.Fprintf(file, "%d %s\n", os.Getpid(), now.Format(time.RFC3339Nano)); err != nil {
		_ = file.Close()
		_ = os.Remove(ownerPath)
		return nil, fmt.Errorf("write update lock owner: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(ownerPath)
		return nil, fmt.Errorf("close update lock owner: %w", err)
	}
	if err := os.Chtimes(path, now, now); err != nil {
		_ = os.Remove(ownerPath)
		return nil, fmt.Errorf("timestamp update lock: %w", err)
	}
	return &Lock{path: path, ownerPath: ownerPath}, nil
}

func reclaimLockDirectory(path string, observedDir os.FileInfo, staleAfter time.Duration) (bool, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return false, ErrLocked
	}
	var ownerPath string
	malformed := false
	for _, entry := range entries {
		switch {
		case entry.Name() == lockReclaimName:
			return false, nil
		case strings.HasPrefix(entry.Name(), lockOwnerPrefix) && ownerPath == "":
			ownerPath = filepath.Join(path, entry.Name())
		case strings.HasPrefix(entry.Name(), lockOwnerPrefix):
			malformed = true
		default:
			malformed = true
		}
	}

	var observedOwner os.FileInfo
	var observedEntries map[string]os.FileInfo
	if ownerPath != "" && !malformed {
		observedOwner, err = os.Lstat(ownerPath)
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		if err != nil || time.Since(observedOwner.ModTime()) < staleAfter {
			return false, nil
		}
	} else {
		if time.Since(observedDir.ModTime()) < staleAfter {
			return false, nil
		}
		observedEntries = make(map[string]os.FileInfo, len(entries))
		for _, entry := range entries {
			info, infoErr := entry.Info()
			if infoErr != nil {
				return false, nil
			}
			observedEntries[entry.Name()] = info
		}
	}

	reclaimPath := filepath.Join(path, lockReclaimName)
	reclaim, err := os.OpenFile(reclaimPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, stateFilePerm)
	if err != nil {
		return false, nil
	}
	if closeErr := reclaim.Close(); closeErr != nil {
		_ = os.Remove(reclaimPath)
		return false, fmt.Errorf("close update lock reclaim marker: %w", closeErr)
	}
	stopReclaim := func() (bool, error) {
		if removeErr := os.Remove(reclaimPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return false, fmt.Errorf("remove update lock reclaim marker: %w", removeErr)
		}
		return false, nil
	}

	if ownerPath != "" && !malformed {
		current, statErr := os.Lstat(ownerPath)
		if statErr == nil && (!os.SameFile(observedOwner, current) || time.Since(current.ModTime()) < staleAfter) {
			return stopReclaim()
		}
		if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
			return stopReclaim()
		}
		if statErr == nil {
			if removeErr := os.Remove(ownerPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				return stopReclaim()
			}
		}
	} else {
		currentDir, statErr := os.Lstat(path)
		if statErr != nil || !os.SameFile(observedDir, currentDir) {
			return stopReclaim()
		}
		currentEntries, readErr := os.ReadDir(path)
		if readErr != nil {
			return stopReclaim()
		}
		for _, entry := range currentEntries {
			if entry.Name() == lockReclaimName {
				continue
			}
			previous, ok := observedEntries[entry.Name()]
			if !ok {
				return stopReclaim()
			}
			current, infoErr := entry.Info()
			if infoErr != nil || !os.SameFile(previous, current) {
				return stopReclaim()
			}
			if removeErr := os.Remove(filepath.Join(path, entry.Name())); removeErr != nil {
				return stopReclaim()
			}
		}
	}

	if removeErr := os.Remove(reclaimPath); removeErr != nil {
		return false, fmt.Errorf("remove update lock reclaim marker: %w", removeErr)
	}
	if removeErr := os.Remove(path); removeErr != nil {
		if errors.Is(removeErr, os.ErrNotExist) {
			return true, nil
		}
		return false, ErrLocked
	}
	return true, nil
}

// Heartbeat renews this lock's lease without ever recreating a missing owner.
func (l *Lock) Heartbeat() error {
	if l == nil {
		return ErrLockOwnershipLost
	}
	l.mutex.Lock()
	defer l.mutex.Unlock()
	if l.released {
		return ErrLockOwnershipLost
	}
	reclaimPath := filepath.Join(l.path, lockReclaimName)
	if _, err := os.Lstat(reclaimPath); err == nil {
		return ErrLockOwnershipLost
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("check update lock reclaim marker: %w", err)
	}

	file, err := os.OpenFile(l.ownerPath, os.O_WRONLY|os.O_TRUNC, stateFilePerm)
	if errors.Is(err, os.ErrNotExist) {
		return ErrLockOwnershipLost
	}
	if err != nil {
		return fmt.Errorf("open update lock owner: %w", err)
	}
	now := time.Now().UTC()
	if _, err := fmt.Fprintf(file, "%d %s\n", os.Getpid(), now.Format(time.RFC3339Nano)); err != nil {
		_ = file.Close()
		return fmt.Errorf("refresh update lock owner: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close update lock owner: %w", err)
	}
	if err := os.Chtimes(l.ownerPath, now, now); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ErrLockOwnershipLost
		}
		return fmt.Errorf("timestamp update lock owner: %w", err)
	}
	if err := os.Chtimes(l.path, now, now); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ErrLockOwnershipLost
		}
		return fmt.Errorf("timestamp update lock: %w", err)
	}
	if _, err := os.Lstat(reclaimPath); err == nil {
		return ErrLockOwnershipLost
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("recheck update lock reclaim marker: %w", err)
	}
	if _, err := os.Lstat(l.ownerPath); errors.Is(err, os.ErrNotExist) {
		return ErrLockOwnershipLost
	} else if err != nil {
		return fmt.Errorf("recheck update lock owner: %w", err)
	}
	return nil
}

// Release drops only this lock's exact owner marker.
func (l *Lock) Release() error {
	if l == nil {
		return nil
	}
	l.mutex.Lock()
	defer l.mutex.Unlock()
	if l.released {
		return nil
	}
	if err := os.Remove(l.ownerPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ErrLockOwnershipLost
		}
		return fmt.Errorf("release update lock owner: %w", err)
	}
	l.released = true
	if err := os.Remove(l.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		if errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, syscall.EEXIST) {
			return nil
		}
		return fmt.Errorf("release update lock: %w", err)
	}
	return nil
}

// resetStaging empties and recreates the staging directory.
func resetStaging(stateDir string) (string, error) {
	staging := StagingDir(stateDir)
	if err := os.RemoveAll(staging); err != nil {
		return "", fmt.Errorf("clear update staging directory: %w", err)
	}
	if err := os.MkdirAll(staging, stateDirFilePerm); err != nil {
		return "", fmt.Errorf("create update staging directory: %w", err)
	}
	return staging, nil
}
