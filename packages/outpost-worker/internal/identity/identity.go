package identity

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

const (
	fileName        = "identity.json"
	currentVersion  = 1
	stateDirEnvName = "OPENOUTPOSTS_STATE_DIR"
)

type File struct {
	Version         int      `json:"version"`
	OutpostID       string   `json:"outpostId"`
	ControlPlaneURL string   `json:"controlPlaneUrl"`
	PrivateKeySeed  string   `json:"privateKeySeed"`
	PublicKey       string   `json:"publicKey"`
	KeyFingerprint  string   `json:"keyFingerprint"`
	Name            string   `json:"name"`
	WorkspaceRoots  []string `json:"workspaceRoots"`
}

func Generate(controlPlaneURL, name string, workspaceRoots []string) (File, error) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return File{}, fmt.Errorf("generate machine key: %w", err)
	}
	digest := sha256.Sum256(publicKey)
	return File{
		Version:         currentVersion,
		ControlPlaneURL: controlPlaneURL,
		PrivateKeySeed:  base64.RawURLEncoding.EncodeToString(privateKey.Seed()),
		PublicKey:       base64.RawURLEncoding.EncodeToString(publicKey),
		KeyFingerprint:  base64.RawURLEncoding.EncodeToString(digest[:]),
		Name:            name,
		WorkspaceRoots:  append([]string(nil), workspaceRoots...),
	}, nil
}

func (f File) PrivateKey() (ed25519.PrivateKey, error) {
	seed, err := base64.RawURLEncoding.DecodeString(f.PrivateKeySeed)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("identity contains an invalid private key")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func (f File) Validate() error {
	if f.Version != currentVersion {
		return fmt.Errorf("identity version %d is not supported", f.Version)
	}
	if f.OutpostID == "" || f.ControlPlaneURL == "" || f.Name == "" || len(f.WorkspaceRoots) == 0 {
		return errors.New("identity is incomplete")
	}
	privateKey, err := f.PrivateKey()
	if err != nil {
		return err
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(f.PublicKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return errors.New("identity contains an invalid public key")
	}
	if !bytes.Equal(privateKey.Public().(ed25519.PublicKey), publicKey) {
		return errors.New("identity public and private keys do not match")
	}
	digest := sha256.Sum256(publicKey)
	if base64.RawURLEncoding.EncodeToString(digest[:]) != f.KeyFingerprint {
		return errors.New("identity key fingerprint does not match")
	}
	return nil
}

func DefaultStateDir() (string, error) {
	if configured := os.Getenv(stateDirEnvName); configured != "" {
		return configured, nil
	}
	switch runtime.GOOS {
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Application Support", "OpenOutposts"), nil
	case "windows":
		if programData := os.Getenv("ProgramData"); programData != "" {
			return filepath.Join(programData, "OpenOutposts"), nil
		}
		return "", errors.New("ProgramData is not set")
	default:
		if os.Geteuid() == 0 {
			return "/var/lib/openoutposts", nil
		}
		if stateHome := os.Getenv("XDG_STATE_HOME"); stateHome != "" {
			return filepath.Join(stateHome, "openoutposts"), nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".local", "state", "openoutposts"), nil
	}
}

func Path(stateDir string) string {
	return filepath.Join(stateDir, fileName)
}

func LoadDefault() (File, error) {
	stateDir, err := DefaultStateDir()
	if err != nil {
		return File{}, err
	}
	return Load(stateDir)
}

func Load(stateDir string) (File, error) {
	content, err := os.ReadFile(Path(stateDir))
	if err != nil {
		return File{}, err
	}
	var identity File
	if err := json.Unmarshal(content, &identity); err != nil {
		return File{}, fmt.Errorf("decode identity: %w", err)
	}
	if err := identity.Validate(); err != nil {
		return File{}, err
	}
	return identity, nil
}

func Save(stateDir string, identity File) error {
	if err := identity.Validate(); err != nil {
		return err
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return fmt.Errorf("create identity directory: %w", err)
	}
	if err := os.Chmod(stateDir, 0o700); err != nil {
		return fmt.Errorf("secure identity directory: %w", err)
	}
	content, err := json.MarshalIndent(identity, "", "  ")
	if err != nil {
		return fmt.Errorf("encode identity: %w", err)
	}
	temporary, err := os.CreateTemp(stateDir, ".identity-*.tmp")
	if err != nil {
		return fmt.Errorf("create identity file: %w", err)
	}
	temporaryName := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryName)
	}
	if err := temporary.Chmod(0o600); err != nil {
		cleanup()
		return fmt.Errorf("secure identity file: %w", err)
	}
	if _, err := temporary.Write(content); err != nil {
		cleanup()
		return fmt.Errorf("write identity file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("sync identity file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		cleanup()
		return fmt.Errorf("close identity file: %w", err)
	}
	if err := os.Rename(temporaryName, Path(stateDir)); err != nil {
		cleanup()
		return fmt.Errorf("install identity file: %w", err)
	}
	return os.Chmod(Path(stateDir), 0o600)
}
