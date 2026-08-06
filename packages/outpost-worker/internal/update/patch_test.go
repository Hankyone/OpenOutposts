package update

import (
	"bytes"
	"context"
	"errors"
	"math/rand/v2"
	"os"
	"path/filepath"
	"testing"

	"github.com/kr/binarydist"
)

// syntheticBinary builds a megabyte-scale blob that compresses like a real
// executable: mostly stable content with a seeded region, so a delta between
// two of them is genuinely small.
func syntheticBinary(t *testing.T, seed uint64) []byte {
	t.Helper()
	source := rand.New(rand.NewPCG(seed, 0x5eed))
	content := make([]byte, 1<<20)
	for index := range content {
		content[index] = byte(index * 7 % 251)
	}
	// Rewrite a few scattered windows, the way a rebuild changes a binary.
	for window := 0; window < 8; window++ {
		start := int(source.Uint64() % uint64(len(content)-4096))
		for offset := 0; offset < 4096; offset++ {
			content[start+offset] = byte(source.Uint64())
		}
	}
	return content
}

func writeFile(t *testing.T, path string, content []byte) string {
	t.Helper()
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func makePatch(t *testing.T, old, updated []byte) []byte {
	t.Helper()
	var patch bytes.Buffer
	if err := binarydist.Diff(bytes.NewReader(old), bytes.NewReader(updated), &patch); err != nil {
		t.Fatal(err)
	}
	return patch.Bytes()
}

func patchEntryFor(old, updated, patch []byte, fromVersion, toVersion string) PatchEntry {
	return PatchEntry{
		Platform:    PlatformKey(),
		FromVersion: fromVersion,
		FromSHA256:  sha256Hex(old),
		ToVersion:   toVersion,
		ToSHA256:    sha256Hex(updated),
		URL:         "outpost-worker/patches/" + fromVersion + "_" + toVersion + "/openoutpost-" + PlatformKey(),
		PatchSHA256: sha256Hex(patch),
		PatchSize:   int64(len(patch)),
	}
}

// fetcherFor serves patches from memory, keyed by the entry's URL.
func fetcherFor(patches map[string][]byte) PatchFetcher {
	return func(_ context.Context, entry PatchEntry) ([]byte, error) {
		content, ok := patches[entry.URL]
		if !ok {
			return nil, errors.New("no patch for " + entry.URL)
		}
		return content, nil
	}
}

func TestApplyChainSingleHop(t *testing.T) {
	t.Parallel()

	workDir := t.TempDir()
	old := syntheticBinary(t, 1)
	updated := syntheticBinary(t, 2)
	patch := makePatch(t, old, updated)
	entry := patchEntryFor(old, updated, patch, "v1.0.0", "v1.1.0")
	oldPath := writeFile(t, filepath.Join(workDir, "installed"), old)

	// The whole point of the delta: a rebuild ships far less than the binary.
	if int64(len(patch)) >= int64(len(updated)) {
		t.Fatalf("patch is %d bytes for a %d-byte binary", len(patch), len(updated))
	}

	result, err := ApplyChain(
		context.Background(),
		oldPath,
		[]PatchEntry{entry},
		fetcherFor(map[string][]byte{entry.URL: patch}),
		filepath.Join(workDir, "staging"),
	)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := fileSHA256(result)
	if err != nil {
		t.Fatal(err)
	}
	if digest != sha256Hex(updated) {
		t.Fatal("patched binary does not match the manifest digest")
	}
}

func TestApplyChainTwoHops(t *testing.T) {
	t.Parallel()

	workDir := t.TempDir()
	first := syntheticBinary(t, 3)
	second := syntheticBinary(t, 4)
	third := syntheticBinary(t, 5)
	firstPatch := makePatch(t, first, second)
	secondPatch := makePatch(t, second, third)
	entries := []PatchEntry{
		patchEntryFor(first, second, firstPatch, "v1.0.0", "v1.1.0"),
		patchEntryFor(second, third, secondPatch, "v1.1.0", "v1.2.0"),
	}
	oldPath := writeFile(t, filepath.Join(workDir, "installed"), first)

	result, err := ApplyChain(
		context.Background(),
		oldPath,
		entries,
		fetcherFor(map[string][]byte{
			entries[0].URL: firstPatch,
			entries[1].URL: secondPatch,
		}),
		filepath.Join(workDir, "staging"),
	)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := fileSHA256(result)
	if err != nil {
		t.Fatal(err)
	}
	if digest != sha256Hex(third) {
		t.Fatal("two-hop chain did not reach the target digest")
	}
	// The installed binary is never touched by patching.
	installed, err := fileSHA256(oldPath)
	if err != nil {
		t.Fatal(err)
	}
	if installed != sha256Hex(first) {
		t.Fatal("the installed binary was modified")
	}
}

func TestApplyChainRejectsATamperedPatch(t *testing.T) {
	t.Parallel()

	workDir := t.TempDir()
	old := syntheticBinary(t, 6)
	updated := syntheticBinary(t, 7)
	patch := makePatch(t, old, updated)
	entry := patchEntryFor(old, updated, patch, "v1.0.0", "v1.1.0")
	oldPath := writeFile(t, filepath.Join(workDir, "installed"), old)

	flipped := append([]byte(nil), patch...)
	flipped[len(flipped)/2] ^= 0xff

	_, err := ApplyChain(
		context.Background(),
		oldPath,
		[]PatchEntry{entry},
		fetcherFor(map[string][]byte{entry.URL: flipped}),
		filepath.Join(workDir, "staging"),
	)
	if !errors.Is(err, ErrChainVerification) {
		t.Fatalf("expected a chain verification failure, got %v", err)
	}
}

// A patch that applies cleanly but produces something other than the digest
// the manifest promised is exactly as unacceptable as a corrupt one.
func TestApplyChainRejectsAnUnexpectedResult(t *testing.T) {
	t.Parallel()

	workDir := t.TempDir()
	old := syntheticBinary(t, 8)
	updated := syntheticBinary(t, 9)
	other := syntheticBinary(t, 10)
	patch := makePatch(t, old, updated)
	entry := patchEntryFor(old, updated, patch, "v1.0.0", "v1.1.0")
	entry.ToSHA256 = sha256Hex(other)
	oldPath := writeFile(t, filepath.Join(workDir, "installed"), old)

	_, err := ApplyChain(
		context.Background(),
		oldPath,
		[]PatchEntry{entry},
		fetcherFor(map[string][]byte{entry.URL: patch}),
		filepath.Join(workDir, "staging"),
	)
	if !errors.Is(err, ErrChainVerification) {
		t.Fatalf("expected a chain verification failure, got %v", err)
	}
}
