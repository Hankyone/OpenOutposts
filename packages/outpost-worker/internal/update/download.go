package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
)

const (
	// maxManifestBytes bounds the manifest and its signature. Both are small
	// and fixed-shape; anything larger is a malfunction or an attack.
	maxManifestBytes = 1 << 20

	// maxArtifactBytes bounds a binary or a patch. The worker is tens of
	// megabytes, so this leaves generous headroom while keeping a hostile or
	// broken origin from filling the disk.
	maxArtifactBytes = 512 << 20
)

// fetchBytes reads at most maxSize bytes from a release URL. The transport
// rule is the same one config.go applies to the control-plane URL: TLS
// everywhere except loopback, because these bytes become the running binary.
func fetchBytes(ctx context.Context, client *http.Client, rawURL string, maxSize int64) ([]byte, error) {
	if err := checkTransportSecurity(rawURL); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", rawURL, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch %s: HTTP %d", rawURL, response.StatusCode)
	}
	content, err := io.ReadAll(io.LimitReader(response.Body, maxSize+1))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", rawURL, err)
	}
	if int64(len(content)) > maxSize {
		return nil, fmt.Errorf("fetch %s: response exceeds %d bytes", rawURL, maxSize)
	}
	return content, nil
}

// fetchVerified downloads content the signed manifest has already committed
// to a digest for. A mismatch is returned rather than logged: nothing else in
// this package may touch bytes that failed this check.
func fetchVerified(
	ctx context.Context,
	client *http.Client,
	rawURL string,
	expectedSHA256 string,
	maxSize int64,
) ([]byte, error) {
	content, err := fetchBytes(ctx, client, rawURL, maxSize)
	if err != nil {
		return nil, err
	}
	digest := sha256Hex(content)
	if digest != expectedSHA256 {
		return nil, fmt.Errorf("%s has digest %s; the manifest names %s", rawURL, digest, expectedSHA256)
	}
	return content, nil
}

func checkTransportSecurity(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("parse release URL: %w", err)
	}
	if parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return errors.New("release URL must be an http(s) URL")
	}
	if parsed.Scheme == "http" && !isLoopbackHost(parsed.Hostname()) {
		return errors.New("release URL must use https except for loopback addresses")
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

func sha256Hex(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}

// joinBase composes a manifest's relative object key onto the release base
// URL. The key has already been validated as relative and traversal-free.
func joinBase(baseURL, key string) string {
	return strings.TrimRight(baseURL, "/") + "/" + strings.TrimLeft(key, "/")
}
