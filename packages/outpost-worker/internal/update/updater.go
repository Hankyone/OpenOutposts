package update

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// updateCheckInterval is how often a worker asks whether it is current.
	// Releases are rare and a machine that is six hours behind is not a
	// problem; a fleet that all checks on the same minute is.
	updateCheckInterval = 6 * time.Hour

	// updateStartupDelay keeps the first check out of the way of the work a
	// worker exists to do — connecting and registering.
	updateStartupDelay = 2 * time.Minute

	// idleSettleDuration is how long the worker must have been doing nothing
	// before its binary is replaced. A lease that was released a second ago is
	// often about to be followed by another.
	idleSettleDuration = time.Minute

	// swapRetryInterval is how often idleness is sampled while waiting.
	swapRetryInterval = 30 * time.Second

	// downloadTimeout bounds one whole download-and-patch cycle.
	downloadTimeout = 10 * time.Minute

	// maxIdleWait stops a busy machine from holding the update lock forever.
	// The next check picks the work up again.
	maxIdleWait = updateCheckInterval

	// restartExitCode tells a service manager this worker wants to be started
	// again. It is deliberately not 2, which the systemd unit treats as a
	// configuration failure that must not be retried.
	restartExitCode = 3

	// devVersion is the version stamp of an unreleased build.
	devVersion = "dev"
)

var (
	// ErrDevBuild means this binary was not produced by the release pipeline,
	// so there is no digest in any manifest that could describe it.
	ErrDevBuild = errors.New("self-update is disabled for development builds")

	// ErrExecUnsupported means this platform cannot replace the running
	// process in place; the caller exits and lets a supervisor restart it.
	ErrExecUnsupported = errors.New("re-exec is not supported on this platform")

	// ErrStaleManifest means the manifest offered is older than one already
	// accepted.
	ErrStaleManifest = errors.New("release manifest is older than the last one accepted")
)

// exitProcess is os.Exit, indirected so tests can observe a requested restart
// instead of ending the test binary.
var exitProcess = os.Exit

// Options configures an Updater. Every collaborator the updater reaches for —
// the clock's jitter aside — arrives here, so tests drive the whole cycle
// without touching the network or the installed binary.
type Options struct {
	StateDir       string
	BaseURL        string
	Channel        string
	CurrentVersion string
	HTTPClient     *http.Client
	// Idle reports whether the worker is holding no lease and running no tool
	// call. Nil means "always idle", which is what the one-shot CLI wants.
	Idle func() bool
	// ExecSelf replaces this process with the binary at the given path.
	ExecSelf func(string) error
	Log      *slog.Logger
	Keys     []ed25519.PublicKey
}

// Updater keeps one worker's binary current.
type Updater struct {
	stateDir       string
	baseURL        string
	channel        string
	currentVersion string
	client         *http.Client
	idle           func() bool
	execSelf       func(string) error
	log            *slog.Logger
	keys           []ed25519.PublicKey
	exit           func(int)
	// checkInterval and gate durations are fields rather than constants so
	// tests can run a full cycle without waiting six hours for it.
	checkInterval  time.Duration
	startupDelay   time.Duration
	idleSettle     time.Duration
	idleSample     time.Duration
	maxIdleWait    time.Duration
	lockStaleAfter time.Duration
}

// New builds an updater, refusing the two states in which self-update must not
// run at all: a development build, which no manifest describes, and a build
// with no embedded release key, which could not verify anything it downloaded.
func New(options Options) (*Updater, error) {
	if options.CurrentVersion == "" || options.CurrentVersion == devVersion {
		return nil, ErrDevBuild
	}
	if len(options.Keys) == 0 {
		return nil, ErrNoReleaseKeys
	}
	if options.StateDir == "" {
		return nil, errors.New("update state directory is required")
	}
	if options.BaseURL == "" {
		return nil, errors.New("release base URL is required")
	}
	if err := checkTransportSecurity(options.BaseURL); err != nil {
		return nil, err
	}
	channel := options.Channel
	if channel == "" {
		channel = DefaultChannel
	}
	if !channelPattern.MatchString(channel) {
		return nil, fmt.Errorf("release channel %q is not valid", channel)
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: downloadTimeout}
	}
	log := options.Log
	if log == nil {
		log = slog.Default()
	}
	return &Updater{
		stateDir:       options.StateDir,
		baseURL:        strings.TrimRight(options.BaseURL, "/") + "/",
		channel:        channel,
		currentVersion: options.CurrentVersion,
		client:         client,
		idle:           options.Idle,
		execSelf:       options.ExecSelf,
		log:            log,
		keys:           options.Keys,
		exit:           exitProcess,
		checkInterval:  updateCheckInterval,
		startupDelay:   updateStartupDelay,
		idleSettle:     idleSettleDuration,
		idleSample:     swapRetryInterval,
		maxIdleWait:    maxIdleWait,
		lockStaleAfter: lockStaleAfter,
	}, nil
}

// DefaultChannel is the release channel a worker follows unless told otherwise.
const DefaultChannel = "stable"

// BaseURL derives the release base from a control-plane URL. The worker's
// stored URL may carry a WebSocket scheme; the release objects are plain HTTP
// objects served by the same origin.
func BaseURL(controlPlaneURL string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(controlPlaneURL), "/")
	if parsed, err := url.Parse(trimmed); err == nil {
		switch parsed.Scheme {
		case "ws":
			parsed.Scheme = "http"
			trimmed = strings.TrimRight(parsed.String(), "/")
		case "wss":
			parsed.Scheme = "https"
			trimmed = strings.TrimRight(parsed.String(), "/")
		}
	}
	return trimmed + "/releases/"
}

// Run checks on a jittered schedule for as long as the context lives. It never
// returns an error: a worker that cannot update is a worker that keeps
// working, and every outcome is already on the log.
func (u *Updater) Run(ctx context.Context) {
	u.log.Info(
		"self-update enabled",
		"channel", u.channel,
		"version", u.currentVersion,
		"check_interval", u.checkInterval,
	)
	if !sleepContext(ctx, u.startupDelay) {
		return
	}
	for {
		u.runCheck(ctx)
		if !sleepContext(ctx, jitteredInterval(u.checkInterval)) {
			return
		}
	}
}

func (u *Updater) runCheck(ctx context.Context) {
	err := u.CheckOnce(ctx)
	switch {
	case err == nil:
	case errors.Is(err, context.Canceled):
	case errors.Is(err, ErrLocked):
		u.log.Info("skipping the update check; another update is in progress")
	case errors.Is(err, ErrExecUnsupported):
		// The binary on disk is already the new one. Exiting is the only way
		// to start running it, and every supported supervisor restarts.
		u.log.Warn("restarting to finish the update", "exit_code", restartExitCode)
		u.exit(restartExitCode)
	default:
		u.log.Warn("update check failed", "error", err)
	}
}

// CheckOnce runs one complete cycle: verify the manifest, decide, download,
// wait for the worker to be idle, swap, and hand over to the new binary.
func (u *Updater) CheckOnce(ctx context.Context) error {
	lock, err := AcquireLock(u.stateDir, u.lockStaleAfter)
	if err != nil {
		return err
	}
	lockHeld := true
	defer func() {
		if lockHeld {
			if releaseErr := lock.Release(); releaseErr != nil {
				u.log.Warn("could not release the update lock", "error", releaseErr)
			}
		}
	}()

	manifest, plan, target, err := u.resolve(ctx)
	if err != nil {
		return err
	}
	if err := lock.Heartbeat(); err != nil {
		return err
	}
	if plan.Kind == UpToDate {
		u.log.Debug("worker is up to date", "version", u.currentVersion)
		return nil
	}
	u.log.Info(
		"update available",
		"current_version", u.currentVersion,
		"target_version", plan.TargetVersion,
		"strategy", plan.Kind.String(),
		"hops", len(plan.Chain),
	)

	// A binary that cannot be written is worth finding out about before
	// anything is downloaded, and it is the single most common reason
	// self-update cannot work on an installed machine.
	if err := DirWritable(filepath.Dir(target)); err != nil {
		return err
	}

	if err := lock.Heartbeat(); err != nil {
		return err
	}
	staging, err := resetStaging(u.stateDir)
	if err != nil {
		return err
	}
	if err := u.checkDiskSpace(staging, plan.Full.Size); err != nil {
		return err
	}

	verified, err := u.stage(ctx, plan, target, staging, lock)
	if err != nil {
		return err
	}
	if err := lock.Heartbeat(); err != nil {
		return err
	}

	if err := u.waitForIdle(ctx, lock); err != nil {
		return err
	}

	if err := lock.Heartbeat(); err != nil {
		return err
	}
	if err := Swap(target, verified); err != nil {
		return err
	}
	if err := lock.Heartbeat(); err != nil {
		return err
	}
	_ = os.RemoveAll(staging)

	state, err := LoadState(u.stateDir)
	if err != nil {
		state = State{Version: stateVersion, LastSeenGeneratedAt: manifest.GeneratedAt}
	}
	state.Pending = &PendingUpdate{
		FromVersion:   u.currentVersion,
		ToVersion:     plan.TargetVersion,
		OldBinaryPath: OldPath(target),
		AppliedAt:     time.Now().UTC(),
	}
	if err := lock.Heartbeat(); err != nil {
		return err
	}
	if err := SaveState(u.stateDir, state); err != nil {
		// The swap already happened. Losing the record only costs the rollback
		// guard, so report it and still start the new binary.
		u.log.Error("could not record the pending update", "error", err)
	}
	u.log.Info(
		"installed a new worker binary",
		"from_version", u.currentVersion,
		"to_version", plan.TargetVersion,
	)

	if err := lock.Release(); err != nil {
		return fmt.Errorf("release update lock before handover: %w", err)
	}
	lockHeld = false
	if u.execSelf == nil {
		return ErrExecUnsupported
	}
	if err := u.execSelf(target); err != nil {
		return err
	}
	return nil
}

// Check reports what an update would do without downloading or installing
// anything. It backs `openoutpost update --check`.
func (u *Updater) Check(ctx context.Context) (Plan, error) {
	lock, err := AcquireLock(u.stateDir, u.lockStaleAfter)
	if err != nil {
		return Plan{}, err
	}
	defer func() { _ = lock.Release() }()
	_, plan, _, err := u.resolve(ctx)
	return plan, err
}

// CurrentVersion is the version this updater believes it is running.
func (u *Updater) CurrentVersion() string { return u.currentVersion }

// ConfirmIfPending marks a freshly installed binary as good and removes the
// one it replaced. The worker calls it once the control plane has accepted its
// registration, which is the narrowest available proof that the new binary
// actually works.
func (u *Updater) ConfirmIfPending() {
	lock, err := AcquireLock(u.stateDir, u.lockStaleAfter)
	if err != nil {
		if !errors.Is(err, ErrLocked) {
			u.log.Warn("could not confirm the pending update", "error", err)
		}
		return
	}
	defer func() { _ = lock.Release() }()

	state, err := LoadState(u.stateDir)
	if err != nil {
		u.log.Warn("could not read the update state", "error", err)
		return
	}
	if state.Pending == nil {
		return
	}
	pending := *state.Pending
	if pending.ToVersion != u.currentVersion {
		u.log.Warn(
			"skipped confirmation for a pending update from another version",
			"pending_version", pending.ToVersion,
			"current_version", u.currentVersion,
		)
		return
	}
	if pending.OldBinaryPath != "" {
		if err := os.Remove(pending.OldBinaryPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			u.log.Warn("could not remove the previous binary", "path", pending.OldBinaryPath, "error", err)
		}
	}
	state.Pending = nil
	if err := SaveState(u.stateDir, state); err != nil {
		u.log.Warn("could not clear the pending update", "error", err)
		return
	}
	u.log.Info(
		"confirmed the updated worker",
		"from_version", pending.FromVersion,
		"to_version", pending.ToVersion,
	)
}

// resolve fetches and verifies the manifest, then plans against the installed
// binary's digest.
func (u *Updater) resolve(ctx context.Context) (Manifest, Plan, string, error) {
	manifest, err := u.fetchManifest(ctx)
	if err != nil {
		return Manifest{}, Plan{}, "", err
	}
	target, err := executableTarget()
	if err != nil {
		return Manifest{}, Plan{}, "", err
	}
	currentSHA256, err := fileSHA256(target)
	if err != nil {
		return Manifest{}, Plan{}, "", err
	}
	plan, err := PlanUpdate(manifest, PlatformKey(), currentSHA256)
	if err != nil {
		return Manifest{}, Plan{}, "", err
	}
	return manifest, plan, target, nil
}

func (u *Updater) fetchManifest(ctx context.Context) (Manifest, error) {
	manifestURL := joinBase(u.baseURL, "outpost-worker/"+u.channel+"/manifest.json")
	manifestBytes, err := fetchBytes(ctx, u.client, manifestURL, maxManifestBytes)
	if err != nil {
		return Manifest{}, err
	}
	// There is no unsigned path. A missing or unreadable signature leaves the
	// worker on the binary it already trusts.
	signatureBytes, err := fetchBytes(ctx, u.client, manifestURL+".sig", maxManifestBytes)
	if err != nil {
		return Manifest{}, err
	}
	manifest, err := ParseAndVerify(manifestBytes, signatureBytes, u.keys)
	if err != nil {
		return Manifest{}, err
	}
	if manifest.Channel != u.channel {
		return Manifest{}, fmt.Errorf(
			"manifest is for channel %q; this worker follows %q",
			manifest.Channel, u.channel,
		)
	}

	state, err := LoadState(u.stateDir)
	if err != nil {
		return Manifest{}, err
	}
	if manifest.GeneratedAt.Before(state.LastSeenGeneratedAt) {
		return Manifest{}, fmt.Errorf(
			"%w: generated %s, last accepted %s",
			ErrStaleManifest,
			manifest.GeneratedAt.UTC().Format(time.RFC3339),
			state.LastSeenGeneratedAt.UTC().Format(time.RFC3339),
		)
	}
	if manifest.GeneratedAt.After(state.LastSeenGeneratedAt) {
		state.LastSeenGeneratedAt = manifest.GeneratedAt
		if err := SaveState(u.stateDir, state); err != nil {
			return Manifest{}, err
		}
	}
	return manifest, nil
}

// stage produces a verified copy of the target binary inside the staging
// directory, patching where that is cheaper and falling back to the full
// download whenever patching cannot be proven to have worked.
func (u *Updater) stage(ctx context.Context, plan Plan, target, staging string, lock *Lock) (string, error) {
	downloadCtx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()

	if plan.Kind == Chain {
		patched, err := ApplyChain(downloadCtx, target, plan.Chain, u.fetchPatch, staging)
		if err == nil {
			return patched, nil
		}
		if !errors.Is(err, ErrChainVerification) {
			return "", err
		}
		u.log.Warn("patch chain failed; falling back to the full download", "error", err)
		if err := lock.Heartbeat(); err != nil {
			return "", err
		}
		if _, resetErr := resetStaging(u.stateDir); resetErr != nil {
			return "", resetErr
		}
	}

	content, err := fetchVerified(
		downloadCtx,
		u.client,
		joinBase(u.baseURL, plan.Full.URL),
		plan.Full.SHA256,
		maxArtifactBytes,
	)
	if err != nil {
		return "", err
	}
	if int64(len(content)) != plan.Full.Size {
		return "", fmt.Errorf(
			"downloaded binary is %d bytes; the manifest names %d",
			len(content), plan.Full.Size,
		)
	}
	path := filepath.Join(staging, "worker.bin")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		return "", fmt.Errorf("write the downloaded binary: %w", err)
	}
	return path, nil
}

func (u *Updater) fetchPatch(ctx context.Context, entry PatchEntry) ([]byte, error) {
	return fetchVerified(
		ctx,
		u.client,
		joinBase(u.baseURL, entry.URL),
		entry.PatchSHA256,
		maxArtifactBytes,
	)
}

// waitForIdle holds the swap until the worker has been doing nothing for the
// settle period. Replacing the binary under a running tool call would not
// interrupt it — the process keeps its open file — but the re-exec that
// follows would, and a session's work would vanish mid-command.
func (u *Updater) waitForIdle(ctx context.Context, lock *Lock) error {
	if err := lock.Heartbeat(); err != nil {
		return err
	}
	if u.idle == nil {
		return nil
	}
	deadline := time.Now().Add(u.maxIdleWait)
	var idleSince time.Time
	for {
		if u.idle() {
			if idleSince.IsZero() {
				idleSince = time.Now()
			}
			if time.Since(idleSince) >= u.idleSettle {
				return nil
			}
		} else {
			idleSince = time.Time{}
		}
		if time.Now().After(deadline) {
			return errors.New("the worker stayed busy; deferring the update to the next check")
		}
		if !sleepContext(ctx, u.idleSample) {
			return ctx.Err()
		}
		if err := lock.Heartbeat(); err != nil {
			return err
		}
	}
}

// jitteredInterval spreads fleet-wide checks over the upper half of the
// interval, the same shape the reconnect loop uses.
func jitteredInterval(interval time.Duration) time.Duration {
	if interval <= 0 {
		return 0
	}
	half := interval / 2
	return interval - half + time.Duration(rand.Int64N(int64(half)+1))
}

// sleepContext waits, reporting false when the context ended first.
func sleepContext(ctx context.Context, duration time.Duration) bool {
	if duration <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
