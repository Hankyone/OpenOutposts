package identity

import (
	"crypto/ed25519"
	"encoding/base64"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSaveAndLoadIdentity(t *testing.T) {
	stateDir := t.TempDir()
	generated, err := Generate("https://control.example.com", "studio", []string{"/workspace"})
	if err != nil {
		t.Fatal(err)
	}
	generated.OutpostID = "outpost-test"
	if err := Save(stateDir, generated); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(Path(stateDir))
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("identity permissions = %o, want 600", got)
	}
	loaded, err := Load(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.OutpostID != generated.OutpostID || loaded.KeyFingerprint != generated.KeyFingerprint {
		t.Fatalf("loaded identity does not match: %#v", loaded)
	}
	content, err := os.ReadFile(filepath.Join(stateDir, fileName))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) == "" {
		t.Fatal("identity file is empty")
	}
}

func TestAddProofSignsCanonicalRequest(t *testing.T) {
	generated, err := Generate("https://control.example.com", "studio", []string{"/workspace"})
	if err != nil {
		t.Fatal(err)
	}
	generated.OutpostID = "outpost-test"
	privateKey, err := generated.PrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodGet, "https://control.example.com/outposts/outpost-test/connect", nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_725_000_000_000)
	if err := AddProof(request, generated.OutpostID, generated.KeyFingerprint, privateKey, now); err != nil {
		t.Fatal(err)
	}

	signature, err := base64.RawURLEncoding.DecodeString(request.Header.Get("X-OpenOutposts-Signature"))
	if err != nil {
		t.Fatal(err)
	}
	timestamp := request.Header.Get("X-OpenOutposts-Timestamp")
	nonce := request.Header.Get("X-OpenOutposts-Nonce")
	publicKey := privateKey.Public().(ed25519.PublicKey)
	if !ed25519.Verify(
		publicKey,
		[]byte(CanonicalProof(http.MethodGet, request.URL.EscapedPath(), generated.OutpostID, timestamp, nonce)),
		signature,
	) {
		t.Fatal("connection proof signature did not verify")
	}
}
