package main

import (
	"crypto/ed25519"
	"encoding/json"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/update"
)

const testPlatform = "linux-amd64"

// buildDir writes a cross-build directory holding one platform's binary.
func buildDir(t *testing.T, content []byte) string {
	t.Helper()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, binaryPrefix+testPlatform), content, 0o755); err != nil {
		t.Fatal(err)
	}
	return directory
}

// syntheticBinary builds a blob that deltas the way a real executable does:
// mostly identical between builds, with a few rewritten windows.
func syntheticBinary(seed uint64) []byte {
	source := rand.New(rand.NewPCG(seed, 0xb14b))
	content := make([]byte, 512<<10)
	for index := range content {
		content[index] = byte(index * 11 % 253)
	}
	for window := 0; window < 4; window++ {
		start := int(source.Uint64() % uint64(len(content)-2048))
		for offset := 0; offset < 2048; offset++ {
			content[start+offset] = byte(source.Uint64())
		}
	}
	return content
}

func readManifest(t *testing.T, dir, channel string) update.Manifest {
	t.Helper()
	content, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(manifestKey(channel))))
	if err != nil {
		t.Fatal(err)
	}
	var manifest update.Manifest
	if err := json.Unmarshal(content, &manifest); err != nil {
		t.Fatal(err)
	}
	return manifest
}

func signManifestInDir(t *testing.T, dir, channel string, key ed25519.PrivateKey) {
	t.Helper()
	path := filepath.Join(dir, filepath.FromSlash(manifestKey(channel)))
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := update.Sign(content, key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+".sig", []byte(update.EncodeSignature(signature)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestGenerateBootstrapsAChannel(t *testing.T) {
	t.Parallel()

	binary := syntheticBinary(1)
	outDir := t.TempDir()
	if err := generate(generateOptions{
		version: "v1.0.0",
		channel: update.DefaultChannel,
		newDir:  buildDir(t, binary),
		outDir:  outDir,
	}); err != nil {
		t.Fatal(err)
	}

	manifest := readManifest(t, outDir, update.DefaultChannel)
	if err := manifest.Validate(); err != nil {
		t.Fatal(err)
	}
	if manifest.Latest.Version != "v1.0.0" || len(manifest.Patches) != 0 {
		t.Fatalf("bootstrap manifest = %#v", manifest)
	}
	artifact := manifest.Latest.Platforms[testPlatform]
	if artifact.SHA256 != digestOf(binary) || artifact.Size != int64(len(binary)) {
		t.Fatalf("artifact = %#v", artifact)
	}
	stored, err := os.ReadFile(filepath.Join(outDir, filepath.FromSlash(artifact.URL)))
	if err != nil {
		t.Fatal(err)
	}
	if digestOf(stored) != artifact.SHA256 {
		t.Fatal("the written blob does not match the manifest")
	}
}

// A second release diffs against the first and stays newer than it, which is
// what the worker's replay check requires.
func TestGenerateProducesAPatchAgainstThePreviousRelease(t *testing.T) {
	t.Parallel()

	first := syntheticBinary(2)
	second := syntheticBinary(3)
	firstDir := t.TempDir()
	if err := generate(generateOptions{
		version:     "v1.0.0",
		newDir:      buildDir(t, first),
		outDir:      firstDir,
		generatedAt: time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatal(err)
	}

	secondDir := t.TempDir()
	if err := generate(generateOptions{
		version:          "v1.1.0",
		newDir:           buildDir(t, second),
		previousManifest: filepath.Join(firstDir, filepath.FromSlash(manifestKey(update.DefaultChannel))),
		previousBlobDir:  firstDir,
		outDir:           secondDir,
		// Deliberately older than the previous release, to prove the tool
		// refuses to emit a manifest a worker would reject as a replay.
		generatedAt: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatal(err)
	}

	manifest := readManifest(t, secondDir, update.DefaultChannel)
	if err := manifest.Validate(); err != nil {
		t.Fatal(err)
	}
	if !manifest.GeneratedAt.After(time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("generatedAt = %s; must be newer than the previous release", manifest.GeneratedAt)
	}
	if len(manifest.Patches) != 1 {
		t.Fatalf("expected one patch, got %d", len(manifest.Patches))
	}
	patch := manifest.Patches[0]
	if patch.FromSHA256 != digestOf(first) || patch.ToSHA256 != digestOf(second) {
		t.Fatalf("patch = %#v", patch)
	}
	if patch.PatchSize >= int64(len(second)) {
		t.Fatalf("patch is %d bytes for a %d-byte binary", patch.PatchSize, len(second))
	}

	// The chain the worker would walk is the one the tool wrote.
	plan, err := update.PlanUpdate(manifest, testPlatform, digestOf(first))
	if err != nil {
		t.Fatal(err)
	}
	if plan.Kind != update.Chain || len(plan.Chain) != 1 {
		t.Fatalf("plan = %#v", plan)
	}
}

func TestGenerateCarriesHistoryForwardAndPrunesIt(t *testing.T) {
	t.Parallel()

	channel := update.DefaultChannel
	previousDir := ""
	previousManifest := ""
	// One more release than the history bound, so the oldest hop must fall off.
	releases := update.MaxManifestPatchHistory + 2
	digests := make([]string, 0, releases)

	for index := 0; index < releases; index++ {
		binary := syntheticBinary(uint64(100 + index))
		digests = append(digests, digestOf(binary))
		outDir := t.TempDir()
		options := generateOptions{
			version:         "v1." + itoa(index) + ".0",
			newDir:          buildDir(t, binary),
			outDir:          outDir,
			previousBlobDir: previousDir,
			generatedAt:     time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(index) * time.Hour),
		}
		options.previousManifest = previousManifest
		if err := generate(options); err != nil {
			t.Fatal(err)
		}
		// The next release reads its predecessor's blobs from where they were
		// written, exactly as CI reads them from the bucket mirror.
		if previousDir != "" {
			if err := copyTree(previousDir, outDir); err != nil {
				t.Fatal(err)
			}
		}
		previousDir = outDir
		previousManifest = filepath.Join(outDir, filepath.FromSlash(manifestKey(channel)))
	}

	manifest := readManifest(t, previousDir, channel)
	if err := manifest.Validate(); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Patches) != update.MaxManifestPatchHistory {
		t.Fatalf("expected %d carried patches, got %d", update.MaxManifestPatchHistory, len(manifest.Patches))
	}
	// The oldest build is beyond the history, so it takes the full download.
	oldest, err := update.PlanUpdate(manifest, testPlatform, digests[0])
	if err != nil {
		t.Fatal(err)
	}
	if oldest.Kind != update.Full {
		t.Fatalf("the oldest build should fall back to a full download, got %s", oldest.Kind)
	}
	// The build one hop back still patches.
	recent, err := update.PlanUpdate(manifest, testPlatform, digests[len(digests)-2])
	if err != nil {
		t.Fatal(err)
	}
	if recent.Kind != update.Chain || len(recent.Chain) != 1 {
		t.Fatalf("plan for the previous release = %#v", recent)
	}
}

func TestVerifyRoundTrip(t *testing.T) {
	t.Parallel()

	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	publicKey := update.EncodePublicKey(privateKey.Public().(ed25519.PublicKey))

	first := syntheticBinary(7)
	second := syntheticBinary(8)
	firstDir := t.TempDir()
	if err := generate(generateOptions{
		version:     "v2.0.0",
		newDir:      buildDir(t, first),
		outDir:      firstDir,
		generatedAt: time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatal(err)
	}
	secondDir := t.TempDir()
	if err := generate(generateOptions{
		version:          "v2.1.0",
		newDir:           buildDir(t, second),
		previousManifest: filepath.Join(firstDir, filepath.FromSlash(manifestKey(update.DefaultChannel))),
		previousBlobDir:  firstDir,
		outDir:           secondDir,
		generatedAt:      time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatal(err)
	}
	signManifestInDir(t, secondDir, update.DefaultChannel, privateKey)

	options := verifyOptions{
		publicKey: publicKey,
		dir:       secondDir,
		blobDir:   firstDir,
		channel:   update.DefaultChannel,
	}
	if err := verify(options); err != nil {
		t.Fatal(err)
	}

	// A corrupted patch is exactly what this gate exists to catch.
	manifest := readManifest(t, secondDir, update.DefaultChannel)
	patchPath := filepath.Join(secondDir, filepath.FromSlash(manifest.Patches[0].URL))
	patch, err := os.ReadFile(patchPath)
	if err != nil {
		t.Fatal(err)
	}
	patch[len(patch)/2] ^= 0xff
	if err := os.WriteFile(patchPath, patch, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := verify(options); err == nil {
		t.Fatal("expected verification to fail on a corrupt patch")
	}

	// So is a tampered manifest.
	if err := os.WriteFile(patchPath, patch, 0o644); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(secondDir, filepath.FromSlash(manifestKey(update.DefaultChannel)))
	content, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	tampered := strings.Replace(string(content), "v2.1.0", "v9.9.9", 1)
	if err := os.WriteFile(manifestPath, []byte(tampered), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := verify(options); err == nil {
		t.Fatal("expected verification to fail on a tampered manifest")
	}
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}

// copyTree merges one bucket mirror into another, the way CI lays the previous
// release's objects beside the new ones.
func copyTree(source, destination string) error {
	return filepath.Walk(source, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, relative)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if _, statErr := os.Stat(target); statErr == nil {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, content, 0o644)
	})
}
