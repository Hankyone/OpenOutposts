package update

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// releaseServer serves a signed manifest and its objects the way the control
// plane's /releases route does, so the updater exercises its real HTTP path.
type releaseServer struct {
	mutex   sync.Mutex
	objects map[string][]byte
	server  *httptest.Server
}

func newReleaseServer(t *testing.T) *releaseServer {
	t.Helper()
	release := &releaseServer{objects: map[string][]byte{}}
	release.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		key := strings.TrimPrefix(request.URL.Path, "/releases/")
		release.mutex.Lock()
		content, ok := release.objects[key]
		release.mutex.Unlock()
		if !ok {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = writer.Write(content)
	}))
	t.Cleanup(release.server.Close)
	return release
}

func (r *releaseServer) put(key string, content []byte) {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	r.objects[key] = content
}

func (r *releaseServer) baseURL() string {
	return r.server.URL + "/releases/"
}

// publish signs the manifest and installs it plus its signature.
func (r *releaseServer) publish(t *testing.T, manifest Manifest, key ed25519.PrivateKey) {
	t.Helper()
	encoded, signature := signManifest(t, manifest, key)
	r.put("outpost-worker/"+manifest.Channel+"/manifest.json", encoded)
	r.put("outpost-worker/"+manifest.Channel+"/manifest.json.sig", signature)
}

// installation is a scratch "installed binary" the updater is allowed to
// replace, standing in for /usr/local/bin/openoutpost.
type installation struct {
	target  string
	content []byte
}

func newInstallation(t *testing.T, content []byte) *installation {
	t.Helper()
	target := filepath.Join(t.TempDir(), "openoutpost")
	if err := os.WriteFile(target, content, 0o755); err != nil {
		t.Fatal(err)
	}
	previous := executableTarget
	executableTarget = func() (string, error) { return target, nil }
	t.Cleanup(func() { executableTarget = previous })
	return &installation{target: target, content: content}
}

// releaseFixture is one complete published release: a new binary, its full
// artifact, and the patch from the installed binary to it.
type releaseFixture struct {
	release   *releaseServer
	publicKey ed25519.PublicKey
	manifest  Manifest
	updated   []byte
	patch     []byte
	blobKey   string
	patchKey  string
}

func newReleaseFixture(t *testing.T, installed []byte) *releaseFixture {
	t.Helper()
	public, private := testKey(t, 30)
	release := newReleaseServer(t)

	updated := syntheticBinary(t, 42)
	patch := makePatch(t, installed, updated)
	blobKey := "outpost-worker/blobs/v1.1.0/openoutpost-" + PlatformKey()
	patchKey := "outpost-worker/patches/v1.0.0_v1.1.0/openoutpost-" + PlatformKey()
	release.put(blobKey, updated)
	release.put(patchKey, patch)

	manifest := Manifest{
		SchemaVersion: SchemaVersion,
		Channel:       DefaultChannel,
		GeneratedAt:   time.Now().UTC().Truncate(time.Second),
		Latest: Latest{
			Version: "v1.1.0",
			Platforms: map[string]PlatformArtifact{
				PlatformKey(): {URL: blobKey, SHA256: sha256Hex(updated), Size: int64(len(updated))},
			},
		},
		Patches: []PatchEntry{{
			Platform:    PlatformKey(),
			FromVersion: "v1.0.0",
			FromSHA256:  sha256Hex(installed),
			ToVersion:   "v1.1.0",
			ToSHA256:    sha256Hex(updated),
			URL:         patchKey,
			PatchSHA256: sha256Hex(patch),
			PatchSize:   int64(len(patch)),
		}},
	}
	release.publish(t, manifest, private)

	return &releaseFixture{
		release:   release,
		publicKey: public,
		manifest:  manifest,
		updated:   updated,
		patch:     patch,
		blobKey:   blobKey,
		patchKey:  patchKey,
	}
}

func (f *releaseFixture) republish(t *testing.T, manifest Manifest) {
	t.Helper()
	_, private := testKey(t, 30)
	f.release.publish(t, manifest, private)
}

func testUpdater(t *testing.T, stateDir string, fixture *releaseFixture, idle func() bool, execSelf func(string) error) *Updater {
	t.Helper()
	updater, err := New(Options{
		StateDir:       stateDir,
		BaseURL:        fixture.release.baseURL(),
		Channel:        DefaultChannel,
		CurrentVersion: "v1.0.0",
		Idle:           idle,
		ExecSelf:       execSelf,
		Log:            discardLogger(),
		Keys:           []ed25519.PublicKey{fixture.publicKey},
	})
	if err != nil {
		t.Fatal(err)
	}
	// Real gating waits minutes; the behaviour under test is the sequencing,
	// not the clock.
	updater.idleSettle = 20 * time.Millisecond
	updater.idleSample = 5 * time.Millisecond
	updater.maxIdleWait = 2 * time.Second
	return updater
}

func TestCheckOnceAppliesAPatchAndHandsOver(t *testing.T) {
	installed := syntheticBinary(t, 41)
	installation := newInstallation(t, installed)
	fixture := newReleaseFixture(t, installed)
	stateDir := t.TempDir()

	executed := make([]string, 0, 1)
	updater := testUpdater(t, stateDir, fixture, func() bool { return true }, func(path string) error {
		handoverLock, err := AcquireLock(stateDir, time.Hour)
		if err != nil {
			return fmt.Errorf("acquire lock during handover: %w", err)
		}
		if err := handoverLock.Release(); err != nil {
			return fmt.Errorf("release handover lock: %w", err)
		}
		executed = append(executed, path)
		return nil
	})

	if err := updater.CheckOnce(context.Background()); err != nil {
		t.Fatal(err)
	}

	digest, err := fileSHA256(installation.target)
	if err != nil {
		t.Fatal(err)
	}
	if digest != sha256Hex(fixture.updated) {
		t.Fatal("the installed binary is not the released one")
	}
	if len(executed) != 1 || executed[0] != installation.target {
		t.Fatalf("expected one re-exec, got %v", executed)
	}
	state, err := LoadState(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if state.Pending == nil || state.Pending.ToVersion != "v1.1.0" || state.Pending.Confirmed {
		t.Fatalf("pending update = %#v", state.Pending)
	}
	if _, err := os.Stat(OldPath(installation.target)); err != nil {
		t.Fatal("the previous binary was not kept for rollback")
	}
	// Staging holds unverified bytes and must not outlive the swap.
	if _, err := os.Stat(StagingDir(stateDir)); !os.IsNotExist(err) {
		t.Fatal("the staging directory survived the update")
	}
}

func TestCheckOnceWaitsForTheWorkerToGoIdle(t *testing.T) {
	installed := syntheticBinary(t, 43)
	installation := newInstallation(t, installed)
	fixture := newReleaseFixture(t, installed)
	stateDir := t.TempDir()

	var mutex sync.Mutex
	busy := true
	idleEntered := make(chan struct{})
	resumeIdle := make(chan struct{})
	heartbeatObserved := make(chan struct{})
	var idleCalls int
	var resumeOnce sync.Once
	resume := func() {
		resumeOnce.Do(func() { close(resumeIdle) })
	}
	defer resume()
	idle := func() bool {
		idleCalls++
		switch idleCalls {
		case 1:
			close(idleEntered)
			<-resumeIdle
		case 2:
			// waitForIdle calls Idle only after refreshing the lock at the end
			// of the previous sample.
			close(heartbeatObserved)
		}
		mutex.Lock()
		defer mutex.Unlock()
		return !busy
	}
	executed := make(chan string, 1)
	updater := testUpdater(t, stateDir, fixture, idle, func(path string) error {
		executed <- path
		return nil
	})
	updater.lockStaleAfter = time.Hour

	done := make(chan error, 1)
	go func() { done <- updater.CheckOnce(context.Background()) }()

	select {
	case <-idleEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("the updater did not begin waiting for the worker to go idle")
	}

	// Make the live owner look abandoned while the updater is blocked inside
	// Idle. The next sample must refresh it before checking Idle again.
	lockPath := filepath.Join(stateDir, lockFileName)
	entries, err := os.ReadDir(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	ownerPath := ""
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), lockOwnerPrefix) {
			if ownerPath != "" {
				t.Fatal("update lock has more than one owner")
			}
			ownerPath = filepath.Join(lockPath, entry.Name())
		}
	}
	if ownerPath == "" {
		t.Fatal("update lock has no owner")
	}
	old := time.Now().Add(-2 * updater.lockStaleAfter)
	if err := os.Chtimes(ownerPath, old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(lockPath, old, old); err != nil {
		t.Fatal(err)
	}
	resume()

	select {
	case <-heartbeatObserved:
	case err := <-done:
		t.Fatalf("the updater stopped before refreshing its lock: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("the updater did not refresh its lock while waiting for idle")
	}
	ownerInfo, err := os.Stat(ownerPath)
	if err != nil {
		t.Fatal(err)
	}
	if !ownerInfo.ModTime().After(old) {
		t.Fatal("idle wait did not refresh the update lock owner")
	}

	// While the worker is busy the binary is staged but never installed, and a
	// competing updater still sees the freshly renewed lock.
	digest, err := fileSHA256(installation.target)
	if err != nil {
		t.Fatal(err)
	}
	if digest != sha256Hex(installed) {
		t.Fatal("the binary was swapped while the worker was busy")
	}
	if contender, err := AcquireLock(stateDir, updater.lockStaleAfter); !errors.Is(err, ErrLocked) {
		if err == nil {
			_ = contender.Release()
		}
		t.Fatalf("idle wait did not keep the update lock live: %v", err)
	}
	select {
	case path := <-executed:
		t.Fatalf("the updater re-executed %s while the worker was busy", path)
	default:
	}

	mutex.Lock()
	busy = false
	mutex.Unlock()

	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the update never completed after the worker went idle")
	}
	digest, err = fileSHA256(installation.target)
	if err != nil {
		t.Fatal(err)
	}
	if digest != sha256Hex(fixture.updated) {
		t.Fatal("the binary was not installed once the worker went idle")
	}
	select {
	case <-executed:
	default:
		t.Fatal("the updater did not hand over to the new binary")
	}
}

func TestCheckOnceReleasesLockBeforeUnsupportedHandover(t *testing.T) {
	installed := syntheticBinary(t, 51)
	newInstallation(t, installed)
	fixture := newReleaseFixture(t, installed)
	stateDir := t.TempDir()

	updater := testUpdater(t, stateDir, fixture, nil, nil)
	if err := updater.CheckOnce(context.Background()); !errors.Is(err, ErrExecUnsupported) {
		t.Fatalf("CheckOnce error = %v, want ErrExecUnsupported", err)
	}
	lock, err := AcquireLock(stateDir, time.Hour)
	if err != nil {
		t.Fatalf("lock remained held after unsupported handover: %v", err)
	}
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
}

// A patch that does not produce the promised binary must not stop the update;
// the full download is the fallback, and it is verified the same way.
func TestCheckOnceFallsBackToTheFullDownload(t *testing.T) {
	installed := syntheticBinary(t, 44)
	installation := newInstallation(t, installed)
	fixture := newReleaseFixture(t, installed)
	corrupted := append([]byte(nil), fixture.patch...)
	corrupted[len(corrupted)/2] ^= 0xff
	fixture.release.put(fixture.patchKey, corrupted)
	stateDir := t.TempDir()

	updater := testUpdater(t, stateDir, fixture, nil, func(string) error { return nil })
	if err := updater.CheckOnce(context.Background()); err != nil {
		t.Fatal(err)
	}

	digest, err := fileSHA256(installation.target)
	if err != nil {
		t.Fatal(err)
	}
	if digest != sha256Hex(fixture.updated) {
		t.Fatal("the full download did not install the released binary")
	}
}

// Nothing installs when the bytes do not match the signed digest, whichever
// route produced them.
func TestCheckOnceRefusesAMismatchedDownload(t *testing.T) {
	installed := syntheticBinary(t, 45)
	installation := newInstallation(t, installed)
	fixture := newReleaseFixture(t, installed)
	corruptedPatch := append([]byte(nil), fixture.patch...)
	corruptedPatch[len(corruptedPatch)/2] ^= 0xff
	fixture.release.put(fixture.patchKey, corruptedPatch)
	fixture.release.put(fixture.blobKey, syntheticBinary(t, 99))
	stateDir := t.TempDir()

	updater := testUpdater(t, stateDir, fixture, nil, func(string) error {
		t.Error("the updater handed over after a failed verification")
		return nil
	})
	if err := updater.CheckOnce(context.Background()); err == nil {
		t.Fatal("expected the update to fail")
	}

	digest, err := fileSHA256(installation.target)
	if err != nil {
		t.Fatal(err)
	}
	if digest != sha256Hex(installed) {
		t.Fatal("the installed binary changed despite a failed verification")
	}
	if _, err := os.Stat(OldPath(installation.target)); !os.IsNotExist(err) {
		t.Fatal("a rollback copy was left behind by a failed update")
	}
}

// Replaying an older manifest is how an attacker who can serve stale objects
// would walk a fleet back onto a build whose bugs are known.
func TestCheckOnceRefusesAStaleManifest(t *testing.T) {
	installed := syntheticBinary(t, 46)
	newInstallation(t, installed)
	fixture := newReleaseFixture(t, installed)
	stateDir := t.TempDir()

	if err := SaveState(stateDir, State{
		Version:             stateVersion,
		LastSeenGeneratedAt: fixture.manifest.GeneratedAt.Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	updater := testUpdater(t, stateDir, fixture, nil, func(string) error {
		t.Error("the updater acted on a replayed manifest")
		return nil
	})
	err := updater.CheckOnce(context.Background())
	if !errors.Is(err, ErrStaleManifest) {
		t.Fatalf("expected the stale-manifest sentinel, got %v", err)
	}
}

func TestCheckOnceRefusesAnUnsignedManifest(t *testing.T) {
	installed := syntheticBinary(t, 47)
	newInstallation(t, installed)
	fixture := newReleaseFixture(t, installed)
	stateDir := t.TempDir()

	// Signed by a key this build does not trust.
	_, foreign := testKey(t, 31)
	fixture.release.publish(t, fixture.manifest, foreign)

	updater := testUpdater(t, stateDir, fixture, nil, func(string) error {
		t.Error("the updater acted on an unverified manifest")
		return nil
	})
	if err := updater.CheckOnce(context.Background()); !errors.Is(err, ErrSignature) {
		t.Fatalf("expected a signature failure, got %v", err)
	}

	// And with the signature removed entirely there is no unsigned fallback.
	fixture.release.mutex.Lock()
	delete(fixture.release.objects, "outpost-worker/"+DefaultChannel+"/manifest.json.sig")
	fixture.release.mutex.Unlock()
	if err := updater.CheckOnce(context.Background()); err == nil {
		t.Fatal("expected a missing signature to stop the update")
	}
}

func TestNewRefusesDevelopmentBuilds(t *testing.T) {
	t.Parallel()

	public, _ := testKey(t, 32)
	_, err := New(Options{
		StateDir:       t.TempDir(),
		BaseURL:        "https://control.example.com/releases/",
		CurrentVersion: "dev",
		Keys:           []ed25519.PublicKey{public},
	})
	if !errors.Is(err, ErrDevBuild) {
		t.Fatalf("expected the development-build sentinel, got %v", err)
	}
}

func TestNewFailsClosedWithoutReleaseKeys(t *testing.T) {
	t.Parallel()

	_, err := New(Options{
		StateDir:       t.TempDir(),
		BaseURL:        "https://control.example.com/releases/",
		CurrentVersion: "v1.0.0",
	})
	if !errors.Is(err, ErrNoReleaseKeys) {
		t.Fatalf("expected the no-keys sentinel, got %v", err)
	}
}

func TestNewRefusesPlaintextReleaseHosts(t *testing.T) {
	t.Parallel()

	public, _ := testKey(t, 33)
	_, err := New(Options{
		StateDir:       t.TempDir(),
		BaseURL:        "http://releases.example.com/releases/",
		CurrentVersion: "v1.0.0",
		Keys:           []ed25519.PublicKey{public},
	})
	if err == nil {
		t.Fatal("expected a plaintext non-loopback release base to be refused")
	}
}

func TestBaseURLFromControlPlaneURL(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		"https://control.example.com":   "https://control.example.com/releases/",
		"https://control.example.com/":  "https://control.example.com/releases/",
		"wss://control.example.com":     "https://control.example.com/releases/",
		"ws://127.0.0.1:8788":           "http://127.0.0.1:8788/releases/",
		"http://127.0.0.1:8788/parent/": "http://127.0.0.1:8788/parent/releases/",
	}
	for input, want := range tests {
		if got := BaseURL(input); got != want {
			t.Fatalf("BaseURL(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestCheckReportsTheLatestVersionWithoutInstalling(t *testing.T) {
	installed := syntheticBinary(t, 48)
	installation := newInstallation(t, installed)
	fixture := newReleaseFixture(t, installed)
	stateDir := t.TempDir()

	updater := testUpdater(t, stateDir, fixture, nil, func(string) error { return nil })
	plan, err := updater.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if plan.Kind != Chain || plan.TargetVersion != "v1.1.0" {
		t.Fatalf("plan = %#v", plan)
	}
	digest, err := fileSHA256(installation.target)
	if err != nil {
		t.Fatal(err)
	}
	if digest != sha256Hex(installed) {
		t.Fatal("--check installed something")
	}
}

func TestCheckOnceIsANoOpWhenAlreadyCurrent(t *testing.T) {
	installed := syntheticBinary(t, 49)
	installation := newInstallation(t, installed)
	fixture := newReleaseFixture(t, installed)
	stateDir := t.TempDir()

	// Republish with the installed binary as the latest artifact.
	current := fixture.manifest
	current.GeneratedAt = current.GeneratedAt.Add(time.Minute)
	current.Latest.Platforms = map[string]PlatformArtifact{
		PlatformKey(): {
			URL:    "outpost-worker/blobs/v1.0.0/openoutpost-" + PlatformKey(),
			SHA256: sha256Hex(installed),
			Size:   int64(len(installed)),
		},
	}
	current.Latest.Version = "v1.0.0"
	current.Patches = nil
	fixture.republish(t, current)

	updater := testUpdater(t, stateDir, fixture, nil, func(string) error {
		t.Error("an up-to-date worker handed over anyway")
		return nil
	})
	if err := updater.CheckOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(OldPath(installation.target)); !os.IsNotExist(err) {
		t.Fatal("an up-to-date worker swapped its binary")
	}
}

func TestManifestChannelMustMatch(t *testing.T) {
	installed := syntheticBinary(t, 50)
	newInstallation(t, installed)
	fixture := newReleaseFixture(t, installed)
	stateDir := t.TempDir()

	// Serve a manifest for a different channel under the stable key.
	mismatched := fixture.manifest
	mismatched.Channel = "beta"
	encoded, err := json.Marshal(mismatched)
	if err != nil {
		t.Fatal(err)
	}
	_, private := testKey(t, 30)
	signature, err := Sign(encoded, private)
	if err != nil {
		t.Fatal(err)
	}
	fixture.release.put("outpost-worker/"+DefaultChannel+"/manifest.json", encoded)
	fixture.release.put("outpost-worker/"+DefaultChannel+"/manifest.json.sig", []byte(EncodeSignature(signature)))

	updater := testUpdater(t, stateDir, fixture, nil, func(string) error { return nil })
	if err := updater.CheckOnce(context.Background()); err == nil {
		t.Fatal("expected a channel mismatch to stop the update")
	}
}
