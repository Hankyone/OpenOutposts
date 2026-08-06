// Package update keeps an installed outpost worker current without an
// operator on the machine. A release manifest is signed with an offline
// Ed25519 key, and the worker refuses to install anything it cannot verify
// against a key compiled into this binary. Binary deltas are the transport
// optimisation, never the trust boundary: every hop and every full download is
// checked against a digest the signed manifest names.
package update

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const (
	// SchemaVersion is the manifest layout this worker understands. A future
	// layout gets a new number and older workers refuse it rather than guess.
	SchemaVersion = 1

	// MaxChainHops bounds how many patches may be applied to reach the latest
	// build. A long chain costs more round trips and more verification than the
	// full download it replaces.
	MaxChainHops = 8

	// MaxManifestPatchHistory bounds how far back the release tool carries
	// patch entries, so the manifest does not grow without limit.
	MaxManifestPatchHistory = 8
)

var (
	// ErrNoReleaseKeys means this build has no embedded release public key, so
	// nothing it downloads could ever be verified. Self-update stays off.
	ErrNoReleaseKeys = errors.New("no release public key is embedded in this build")

	// ErrSignature means the detached signature did not verify against any
	// embedded release key.
	ErrSignature = errors.New("release manifest signature is not valid")
)

// Manifest is the signed description of a channel's current release and the
// binary patches that reach it.
type Manifest struct {
	SchemaVersion int          `json:"schemaVersion"`
	Channel       string       `json:"channel"`
	GeneratedAt   time.Time    `json:"generatedAt"`
	Latest        Latest       `json:"latest"`
	Patches       []PatchEntry `json:"patches"`
}

// Latest names the build every worker on the channel should converge on.
type Latest struct {
	Version string `json:"version"`
	// Platforms is keyed by GOOS-GOARCH, matching PlatformKey.
	Platforms map[string]PlatformArtifact `json:"platforms"`
}

// PlatformArtifact is one platform's complete binary.
type PlatformArtifact struct {
	// URL is an object key relative to the release base URL, never an
	// absolute URL: the worker composes it against its own control plane so a
	// manifest cannot redirect a download elsewhere.
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// PatchEntry is one binary delta hop. Chain discovery keys on FromSHA256, not
// on version strings: the digest is what the worker can actually observe about
// the binary it is running.
type PatchEntry struct {
	Platform    string `json:"platform"`
	FromVersion string `json:"fromVersion"`
	FromSHA256  string `json:"fromSha256"`
	ToVersion   string `json:"toVersion"`
	ToSHA256    string `json:"toSha256"`
	URL         string `json:"url"`
	PatchSHA256 string `json:"patchSha256"`
	PatchSize   int64  `json:"patchSize"`
}

var (
	digestPattern   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	versionPattern  = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)
	platformPattern = regexp.MustCompile(`^[a-z0-9]+-[a-z0-9]+$`)
	channelPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)
	urlKeyPattern   = regexp.MustCompile(`^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$`)
)

// PlatformKey is this build's key into Latest.Platforms.
func PlatformKey() string {
	return runtime.GOOS + "-" + runtime.GOARCH
}

// ParseAndVerify checks the detached signature over the exact manifest bytes
// before any of them are parsed, so malformed or hostile JSON never reaches
// the decoder on an unsigned document.
func ParseAndVerify(manifestBytes, signatureBytes []byte, keys []ed25519.PublicKey) (Manifest, error) {
	if len(keys) == 0 {
		return Manifest{}, ErrNoReleaseKeys
	}
	signature, err := DecodeSignature(signatureBytes)
	if err != nil {
		return Manifest{}, err
	}
	verified := false
	for _, key := range keys {
		if len(key) != ed25519.PublicKeySize {
			continue
		}
		if ed25519.Verify(key, manifestBytes, signature) {
			verified = true
			break
		}
	}
	if !verified {
		return Manifest{}, ErrSignature
	}

	var manifest Manifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("decode release manifest: %w", err)
	}
	if err := manifest.Validate(); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

// Validate rejects a manifest this worker must not act on, whether it was
// signed or not. A valid signature proves origin, not sanity.
func (m Manifest) Validate() error {
	if m.SchemaVersion != SchemaVersion {
		return fmt.Errorf("release manifest schema version %d is not supported", m.SchemaVersion)
	}
	if !channelPattern.MatchString(m.Channel) {
		return fmt.Errorf("release manifest channel %q is not valid", m.Channel)
	}
	if m.GeneratedAt.IsZero() {
		return errors.New("release manifest has no generation time")
	}
	if !versionPattern.MatchString(m.Latest.Version) {
		return fmt.Errorf("release version %q is not a v-prefixed semantic version", m.Latest.Version)
	}
	if len(m.Latest.Platforms) == 0 {
		return errors.New("release manifest names no platform artifacts")
	}
	for platform, artifact := range m.Latest.Platforms {
		if !platformPattern.MatchString(platform) {
			return fmt.Errorf("platform key %q is not GOOS-GOARCH", platform)
		}
		if err := validateObjectKey(artifact.URL); err != nil {
			return fmt.Errorf("artifact for %s: %w", platform, err)
		}
		if !digestPattern.MatchString(artifact.SHA256) {
			return fmt.Errorf("artifact for %s has an invalid sha256", platform)
		}
		if artifact.Size <= 0 {
			return fmt.Errorf("artifact for %s has a non-positive size", platform)
		}
	}
	for index, patch := range m.Patches {
		if err := patch.validate(); err != nil {
			return fmt.Errorf("patch %d: %w", index, err)
		}
	}
	return nil
}

func (p PatchEntry) validate() error {
	if !platformPattern.MatchString(p.Platform) {
		return fmt.Errorf("platform key %q is not GOOS-GOARCH", p.Platform)
	}
	if !versionPattern.MatchString(p.FromVersion) || !versionPattern.MatchString(p.ToVersion) {
		return errors.New("versions must be v-prefixed semantic versions")
	}
	if !digestPattern.MatchString(p.FromSHA256) || !digestPattern.MatchString(p.ToSHA256) {
		return errors.New("from and to digests must be lowercase hex sha256")
	}
	if !digestPattern.MatchString(p.PatchSHA256) {
		return errors.New("patch digest must be lowercase hex sha256")
	}
	if err := validateObjectKey(p.URL); err != nil {
		return err
	}
	if p.PatchSize <= 0 {
		return errors.New("patch size must be positive")
	}
	return nil
}

// validateObjectKey keeps a manifest confined to the release prefix it is
// served from: relative keys only, no traversal, no scheme, no host.
func validateObjectKey(key string) error {
	if key == "" {
		return errors.New("object key is empty")
	}
	if strings.HasPrefix(key, "/") || strings.Contains(key, "\\") || strings.Contains(key, "://") {
		return fmt.Errorf("object key %q must be relative to the release base", key)
	}
	if !urlKeyPattern.MatchString(key) {
		return fmt.Errorf("object key %q contains unsupported characters", key)
	}
	for _, segment := range strings.Split(key, "/") {
		if segment == "." || segment == ".." {
			return fmt.Errorf("object key %q traverses outside the release base", key)
		}
	}
	return nil
}
