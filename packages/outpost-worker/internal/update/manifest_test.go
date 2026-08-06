package update

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// testKey derives a deterministic Ed25519 key pair so a failure is always the
// same failure.
func testKey(t *testing.T, seed byte) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	material := make([]byte, ed25519.SeedSize)
	for index := range material {
		material[index] = seed + byte(index)
	}
	private := ed25519.NewKeyFromSeed(material)
	return private.Public().(ed25519.PublicKey), private
}

func validManifest() Manifest {
	return Manifest{
		SchemaVersion: SchemaVersion,
		Channel:       "stable",
		GeneratedAt:   time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC),
		Latest: Latest{
			Version: "v1.2.0",
			Platforms: map[string]PlatformArtifact{
				"linux-amd64": {
					URL:    "outpost-worker/blobs/v1.2.0/openoutpost-linux-amd64",
					SHA256: strings.Repeat("a", 64),
					Size:   4096,
				},
			},
		},
		Patches: []PatchEntry{
			{
				Platform:    "linux-amd64",
				FromVersion: "v1.1.0",
				FromSHA256:  strings.Repeat("b", 64),
				ToVersion:   "v1.2.0",
				ToSHA256:    strings.Repeat("a", 64),
				URL:         "outpost-worker/patches/v1.1.0_v1.2.0/openoutpost-linux-amd64",
				PatchSHA256: strings.Repeat("c", 64),
				PatchSize:   512,
			},
		},
	}
}

func signManifest(t *testing.T, manifest Manifest, key ed25519.PrivateKey) ([]byte, []byte) {
	t.Helper()
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := Sign(encoded, key)
	if err != nil {
		t.Fatal(err)
	}
	return encoded, []byte(EncodeSignature(signature))
}

func TestParseAndVerifyRoundTrip(t *testing.T) {
	t.Parallel()

	public, private := testKey(t, 1)
	encoded, signature := signManifest(t, validManifest(), private)

	parsed, err := ParseAndVerify(encoded, signature, []ed25519.PublicKey{public})
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Latest.Version != "v1.2.0" || len(parsed.Patches) != 1 {
		t.Fatalf("unexpected manifest: %#v", parsed)
	}
}

func TestParseAndVerifyRejectsTamperedManifest(t *testing.T) {
	t.Parallel()

	public, private := testKey(t, 2)
	encoded, signature := signManifest(t, validManifest(), private)
	tampered := []byte(strings.Replace(string(encoded), "v1.2.0", "v9.9.9", 1))

	_, err := ParseAndVerify(tampered, signature, []ed25519.PublicKey{public})
	if !errors.Is(err, ErrSignature) {
		t.Fatalf("expected a signature failure, got %v", err)
	}
}

func TestParseAndVerifyRejectsWrongKey(t *testing.T) {
	t.Parallel()

	_, signingKey := testKey(t, 3)
	otherPublic, _ := testKey(t, 4)
	encoded, signature := signManifest(t, validManifest(), signingKey)

	_, err := ParseAndVerify(encoded, signature, []ed25519.PublicKey{otherPublic})
	if !errors.Is(err, ErrSignature) {
		t.Fatalf("expected a signature failure, got %v", err)
	}
}

func TestParseAndVerifyRejectsMissingSignature(t *testing.T) {
	t.Parallel()

	public, private := testKey(t, 5)
	encoded, _ := signManifest(t, validManifest(), private)

	if _, err := ParseAndVerify(encoded, nil, []ed25519.PublicKey{public}); err == nil {
		t.Fatal("expected an empty signature to be refused")
	}
	if _, err := ParseAndVerify(encoded, []byte("not-base64!!"), []ed25519.PublicKey{public}); err == nil {
		t.Fatal("expected a malformed signature to be refused")
	}
}

func TestParseAndVerifyFailsClosedWithoutKeys(t *testing.T) {
	t.Parallel()

	_, private := testKey(t, 6)
	encoded, signature := signManifest(t, validManifest(), private)

	_, err := ParseAndVerify(encoded, signature, nil)
	if !errors.Is(err, ErrNoReleaseKeys) {
		t.Fatalf("expected the no-keys sentinel, got %v", err)
	}
}

// A rotation ships the old and the new key together, still signing with the
// old one, so no installed worker is left unable to verify.
func TestParseAndVerifyAcceptsAnyKeyInTheSet(t *testing.T) {
	t.Parallel()

	oldPublic, oldPrivate := testKey(t, 7)
	newPublic, newPrivate := testKey(t, 8)
	keys := []ed25519.PublicKey{oldPublic, newPublic}

	for name, signer := range map[string]ed25519.PrivateKey{"old key": oldPrivate, "new key": newPrivate} {
		encoded, signature := signManifest(t, validManifest(), signer)
		if _, err := ParseAndVerify(encoded, signature, keys); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestManifestValidate(t *testing.T) {
	t.Parallel()

	withChanges := func(mutate func(m *Manifest)) Manifest {
		manifest := validManifest()
		manifest.Patches = append([]PatchEntry(nil), manifest.Patches...)
		platforms := make(map[string]PlatformArtifact, len(manifest.Latest.Platforms))
		for key, value := range manifest.Latest.Platforms {
			platforms[key] = value
		}
		manifest.Latest.Platforms = platforms
		mutate(&manifest)
		return manifest
	}

	tests := []struct {
		name     string
		manifest Manifest
		wantErr  bool
	}{
		{name: "valid", manifest: validManifest()},
		{
			name:     "unsupported schema version",
			manifest: withChanges(func(m *Manifest) { m.SchemaVersion = SchemaVersion + 1 }),
			wantErr:  true,
		},
		{
			name:     "missing generation time",
			manifest: withChanges(func(m *Manifest) { m.GeneratedAt = time.Time{} }),
			wantErr:  true,
		},
		{
			name:     "version without a v prefix",
			manifest: withChanges(func(m *Manifest) { m.Latest.Version = "1.2.0" }),
			wantErr:  true,
		},
		{
			name:     "no platforms",
			manifest: withChanges(func(m *Manifest) { m.Latest.Platforms = nil }),
			wantErr:  true,
		},
		{
			name: "platform key is not GOOS-GOARCH",
			manifest: withChanges(func(m *Manifest) {
				artifact := m.Latest.Platforms["linux-amd64"]
				delete(m.Latest.Platforms, "linux-amd64")
				m.Latest.Platforms["Linux/AMD64"] = artifact
			}),
			wantErr: true,
		},
		{
			name: "digest is not hex sha256",
			manifest: withChanges(func(m *Manifest) {
				artifact := m.Latest.Platforms["linux-amd64"]
				artifact.SHA256 = "not-a-digest"
				m.Latest.Platforms["linux-amd64"] = artifact
			}),
			wantErr: true,
		},
		{
			name: "non-positive size",
			manifest: withChanges(func(m *Manifest) {
				artifact := m.Latest.Platforms["linux-amd64"]
				artifact.Size = 0
				m.Latest.Platforms["linux-amd64"] = artifact
			}),
			wantErr: true,
		},
		{
			name: "absolute artifact key",
			manifest: withChanges(func(m *Manifest) {
				artifact := m.Latest.Platforms["linux-amd64"]
				artifact.URL = "/worker/blobs/v1.2.0/openoutpost-linux-amd64"
				m.Latest.Platforms["linux-amd64"] = artifact
			}),
			wantErr: true,
		},
		{
			name: "artifact key escapes the release base",
			manifest: withChanges(func(m *Manifest) {
				artifact := m.Latest.Platforms["linux-amd64"]
				artifact.URL = "outpost-worker/../../secrets"
				m.Latest.Platforms["linux-amd64"] = artifact
			}),
			wantErr: true,
		},
		{
			name: "artifact key is an absolute URL",
			manifest: withChanges(func(m *Manifest) {
				artifact := m.Latest.Platforms["linux-amd64"]
				artifact.URL = "https://evil.example.com/worker"
				m.Latest.Platforms["linux-amd64"] = artifact
			}),
			wantErr: true,
		},
		{
			name:     "patch with a bad digest",
			manifest: withChanges(func(m *Manifest) { m.Patches[0].PatchSHA256 = "short" }),
			wantErr:  true,
		},
		{
			name:     "patch with a non-positive size",
			manifest: withChanges(func(m *Manifest) { m.Patches[0].PatchSize = 0 }),
			wantErr:  true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := test.manifest.Validate()
			if test.wantErr && err == nil {
				t.Fatal("expected an error")
			}
			if !test.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

// The embedded key list is compiled in, so a typo has to fail here rather than
// on a machine that then silently stops updating.
func TestEmbeddedReleaseKeysDecode(t *testing.T) {
	t.Parallel()

	for _, encoded := range releasePublicKeysBase64 {
		if _, err := DecodePublicKey(encoded); err != nil {
			t.Fatalf("embedded release key %q does not decode: %v", encoded, err)
		}
	}
	if len(ReleasePublicKeys()) != len(releasePublicKeysBase64) {
		t.Fatal("an embedded release key was dropped as unparseable")
	}
}
