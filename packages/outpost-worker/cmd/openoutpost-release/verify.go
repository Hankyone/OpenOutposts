package main

import (
	"context"
	"crypto/ed25519"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/update"
)

type verifyOptions struct {
	publicKey string
	dir       string
	blobDir   string
	channel   string
}

// runVerify is the gate a release must pass before anything is published. It
// verifies the signature with the same code the worker runs, and then applies
// every patch the manifest offers against the binary it claims to start from.
// A patch that cannot reproduce the promised digest here would have failed on
// every machine in the fleet instead.
func runVerify(arguments []string) error {
	flags := flag.NewFlagSet("verify", flag.ContinueOnError)
	publicKey := flags.String("public-key", "", "base64 release public key")
	dir := flags.String("dir", "", "directory holding the generated bucket layout")
	blobDir := flags.String("blob-dir", "", "additional bucket-root mirror to resolve previous blobs from")
	channel := flags.String("channel", update.DefaultChannel, "release channel")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	return verify(verifyOptions{
		publicKey: *publicKey,
		dir:       *dir,
		blobDir:   *blobDir,
		channel:   *channel,
	})
}

func verify(options verifyOptions) error {
	if options.publicKey == "" || options.dir == "" {
		return errors.New("verify requires --public-key and --dir")
	}
	if options.channel == "" {
		options.channel = update.DefaultChannel
	}
	key, err := update.DecodePublicKey(options.publicKey)
	if err != nil {
		return err
	}

	manifestPath := filepath.Join(options.dir, filepath.FromSlash(manifestKey(options.channel)))
	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("read manifest: %w", err)
	}
	signatureBytes, err := os.ReadFile(manifestPath + ".sig")
	if err != nil {
		return fmt.Errorf("read signature: %w", err)
	}
	manifest, err := update.ParseAndVerify(manifestBytes, signatureBytes, []ed25519.PublicKey{key})
	if err != nil {
		return err
	}
	if manifest.Channel != options.channel {
		return fmt.Errorf("manifest is for channel %q, not %q", manifest.Channel, options.channel)
	}

	for platform, artifact := range manifest.Latest.Platforms {
		content, err := readObject(options, artifact.URL)
		if err != nil {
			return fmt.Errorf("%s artifact: %w", platform, err)
		}
		if digestOf(content) != artifact.SHA256 {
			return fmt.Errorf("%s artifact does not match its manifest digest", platform)
		}
		if int64(len(content)) != artifact.Size {
			return fmt.Errorf("%s artifact is %d bytes; the manifest names %d", platform, len(content), artifact.Size)
		}
	}

	workDir, err := os.MkdirTemp("", "openoutpost-verify-*")
	if err != nil {
		return fmt.Errorf("create verification directory: %w", err)
	}
	defer os.RemoveAll(workDir)

	applied := 0
	for index, entry := range manifest.Patches {
		fromContent, err := readObject(options, blobKey(entry.FromVersion, entry.Platform))
		if errors.Is(err, os.ErrNotExist) {
			// The blob this patch starts from is older than the mirror holds.
			// Its own release verified it; nothing here can.
			continue
		}
		if err != nil {
			return fmt.Errorf("patch %d source: %w", index, err)
		}
		if digestOf(fromContent) != entry.FromSHA256 {
			return fmt.Errorf("patch %d starts from a binary that is not the one it names", index)
		}
		fromPath := filepath.Join(workDir, "from.bin")
		if err := os.WriteFile(fromPath, fromContent, 0o600); err != nil {
			return err
		}
		fetch := func(_ context.Context, patch update.PatchEntry) ([]byte, error) {
			return readObject(options, patch.URL)
		}
		if _, err := update.ApplyChain(
			context.Background(),
			fromPath,
			[]update.PatchEntry{entry},
			fetch,
			filepath.Join(workDir, "apply"),
		); err != nil {
			return fmt.Errorf("patch %d (%s %s -> %s): %w", index, entry.Platform, entry.FromVersion, entry.ToVersion, err)
		}
		applied++
	}

	fmt.Fprintf(
		os.Stderr,
		"verified %s %s: %d platforms, %d of %d patches applied\n",
		manifest.Channel, manifest.Latest.Version, len(manifest.Latest.Platforms), applied, len(manifest.Patches),
	)
	return nil
}

// readObject resolves a bucket key against the generated directory first and
// the previous mirror second, so a release can be checked against blobs it did
// not itself produce.
func readObject(options verifyOptions, key string) ([]byte, error) {
	content, err := os.ReadFile(filepath.Join(options.dir, filepath.FromSlash(key)))
	if err == nil {
		return content, nil
	}
	if !errors.Is(err, os.ErrNotExist) || options.blobDir == "" {
		return nil, err
	}
	return os.ReadFile(filepath.Join(options.blobDir, filepath.FromSlash(key)))
}
