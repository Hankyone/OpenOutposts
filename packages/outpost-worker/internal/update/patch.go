package update

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/kr/binarydist"
)

// ErrChainVerification marks any failure to turn the running binary into the
// digest the manifest names. Callers treat it as "patching did not work here"
// and fall back to the full download rather than giving up on the update.
var ErrChainVerification = errors.New("patch chain did not produce the expected binary")

// PatchFetcher retrieves one patch's bytes. The updater supplies an HTTP
// implementation; tests supply the patch directly.
type PatchFetcher func(ctx context.Context, entry PatchEntry) ([]byte, error)

// ApplyChain walks the hops from the currently installed binary to the target
// build, writing each intermediate result into workDir. Every hop is checked
// twice — the patch against its own digest before it is applied, the result
// against the digest the manifest promises — so a corrupted delta can never
// become an installed binary.
func ApplyChain(
	ctx context.Context,
	oldPath string,
	chain []PatchEntry,
	fetch PatchFetcher,
	workDir string,
) (string, error) {
	if len(chain) == 0 {
		return "", errors.New("patch chain is empty")
	}
	if err := os.MkdirAll(workDir, 0o700); err != nil {
		return "", fmt.Errorf("create patch working directory: %w", err)
	}

	currentPath := oldPath
	// Only intermediates this function created may be removed; oldPath is the
	// installed binary.
	produced := make([]string, 0, len(chain))
	cleanup := func(keep string) {
		for _, path := range produced {
			if path != keep {
				_ = os.Remove(path)
			}
		}
	}

	for index, hop := range chain {
		if err := ctx.Err(); err != nil {
			cleanup("")
			return "", err
		}
		patchBytes, err := fetch(ctx, hop)
		if err != nil {
			cleanup("")
			return "", fmt.Errorf("%w: fetch hop %d: %v", ErrChainVerification, index, err)
		}
		if digest := sha256Hex(patchBytes); digest != hop.PatchSHA256 {
			cleanup("")
			return "", fmt.Errorf(
				"%w: hop %d patch has digest %s; the manifest names %s",
				ErrChainVerification, index, digest, hop.PatchSHA256,
			)
		}

		source, err := os.Open(currentPath)
		if err != nil {
			cleanup("")
			return "", fmt.Errorf("open patch source: %w", err)
		}
		nextPath := filepath.Join(workDir, fmt.Sprintf("hop-%d.bin", index))
		next, err := os.OpenFile(nextPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			source.Close()
			cleanup("")
			return "", fmt.Errorf("create patch output: %w", err)
		}
		patchErr := binarydist.Patch(source, next, bytes.NewReader(patchBytes))
		source.Close()
		closeErr := next.Close()
		produced = append(produced, nextPath)
		if patchErr != nil {
			cleanup("")
			return "", fmt.Errorf("%w: hop %d: %v", ErrChainVerification, index, patchErr)
		}
		if closeErr != nil {
			cleanup("")
			return "", fmt.Errorf("close patch output: %w", closeErr)
		}

		digest, err := fileSHA256(nextPath)
		if err != nil {
			cleanup("")
			return "", err
		}
		if digest != hop.ToSHA256 {
			cleanup("")
			return "", fmt.Errorf(
				"%w: hop %d produced digest %s; the manifest names %s",
				ErrChainVerification, index, digest, hop.ToSHA256,
			)
		}
		currentPath = nextPath
	}

	cleanup(currentPath)
	return currentPath, nil
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open %s: %w", path, err)
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}
