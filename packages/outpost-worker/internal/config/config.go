package config

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/identity"
)

type Config struct {
	ControlPlaneURL string
	ID              string
	Name            string
	Token           string
	PrivateKey      ed25519.PrivateKey
	KeyFingerprint  string
	Platform        string
	Architecture    string
	WorkspaceRoots  []string
	identityError   error
}

var outpostIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`)

func FromEnvironment() Config {
	hostname, _ := os.Hostname()
	name := hostname
	if configuredName := os.Getenv("OPENOUTPOSTS_NAME"); configuredName != "" {
		name = configuredName
	}
	id := hostname
	if configuredID := os.Getenv("OPENOUTPOSTS_ID"); configuredID != "" {
		id = configuredID
	}

	var workspaceRoots []string
	for _, root := range strings.Split(os.Getenv("OPENOUTPOSTS_WORKSPACE_ROOTS"), ",") {
		if trimmed := strings.TrimSpace(root); trimmed != "" {
			workspaceRoots = append(workspaceRoots, trimmed)
		}
	}

	cfg := Config{
		ControlPlaneURL: os.Getenv("OPENOUTPOSTS_CONTROL_PLANE_URL"),
		ID:              id,
		Name:            name,
		Token:           os.Getenv("OPENOUTPOSTS_TOKEN"),
		Platform:        runtime.GOOS,
		Architecture:    runtime.GOARCH,
		WorkspaceRoots:  workspaceRoots,
	}
	storedIdentity, err := identity.LoadDefault()
	if err == nil {
		privateKey, keyErr := storedIdentity.PrivateKey()
		if keyErr != nil {
			cfg.identityError = keyErr
			return cfg
		}
		cfg.ControlPlaneURL = storedIdentity.ControlPlaneURL
		if configuredURL := os.Getenv("OPENOUTPOSTS_CONTROL_PLANE_URL"); configuredURL != "" {
			cfg.ControlPlaneURL = configuredURL
		}
		cfg.ID = storedIdentity.OutpostID
		cfg.Name = storedIdentity.Name
		cfg.PrivateKey = privateKey
		cfg.KeyFingerprint = storedIdentity.KeyFingerprint
		cfg.WorkspaceRoots = append([]string(nil), storedIdentity.WorkspaceRoots...)
	} else if !errors.Is(err, os.ErrNotExist) {
		cfg.identityError = err
	}
	return cfg
}

func (c Config) Validate() error {
	if c.identityError != nil {
		return fmt.Errorf("load machine identity: %w", c.identityError)
	}
	if c.ControlPlaneURL == "" {
		return errors.New("OPENOUTPOSTS_CONTROL_PLANE_URL is required")
	}
	parsedURL, err := url.Parse(c.ControlPlaneURL)
	if err != nil || parsedURL.Host == "" || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https" && parsedURL.Scheme != "ws" && parsedURL.Scheme != "wss") {
		return errors.New("OPENOUTPOSTS_CONTROL_PLANE_URL must be an http(s) or ws(s) URL")
	}
	// Identity proofs, legacy tokens, and every tool payload ride over this
	// transport. Loopback is the only place plaintext is acceptable.
	if (parsedURL.Scheme == "http" || parsedURL.Scheme == "ws") && !isLoopbackHost(parsedURL.Hostname()) {
		return errors.New("OPENOUTPOSTS_CONTROL_PLANE_URL must use https/wss except for loopback addresses")
	}
	if len(c.PrivateKey) != ed25519.PrivateKeySize && c.Token == "" {
		return errors.New("machine identity is missing; run 'openoutpost enroll'")
	}
	if len(c.PrivateKey) == ed25519.PrivateKeySize && c.KeyFingerprint == "" {
		return errors.New("machine identity fingerprint is missing")
	}
	if c.Name == "" {
		return errors.New("outpost name is required")
	}
	if !outpostIDPattern.MatchString(c.ID) {
		return fmt.Errorf("OPENOUTPOSTS_ID must match %s", outpostIDPattern.String())
	}
	// Without configured roots the control plane could lease any directory on
	// the machine. Confinement must be opt-out-impossible, not opt-in.
	if len(c.WorkspaceRoots) == 0 {
		return errors.New("OPENOUTPOSTS_WORKSPACE_ROOTS is required: list the directories this worker may expose")
	}
	for _, root := range c.WorkspaceRoots {
		if !filepath.IsAbs(root) {
			return fmt.Errorf("workspace root %q must be an absolute path", root)
		}
	}
	return nil
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
