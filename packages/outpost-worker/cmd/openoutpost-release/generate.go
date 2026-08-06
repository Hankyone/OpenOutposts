package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/update"
	"github.com/kr/binarydist"
)

// binaryPrefix is how a cross-built worker is named in the build directory:
// openoutpost-<goos>-<goarch>. The suffix is the manifest's platform key.
const binaryPrefix = "openoutpost-"

// The bucket layout. Blobs and patches are immutable and versioned in their
// key, so they can be cached forever; the manifest is the only mutable object.
func blobKey(version, platform string) string {
	return "outpost-worker/blobs/" + version + "/" + binaryPrefix + platform
}

func patchKey(fromVersion, toVersion, platform string) string {
	return "outpost-worker/patches/" + fromVersion + "_" + toVersion + "/" + binaryPrefix + platform
}

func manifestKey(channel string) string {
	return "outpost-worker/" + channel + "/manifest.json"
}

type generateOptions struct {
	version          string
	channel          string
	newDir           string
	previousManifest string
	previousBlobDir  string
	outDir           string
	// generatedAt is injectable so a test can assert monotonicity without
	// depending on the wall clock.
	generatedAt time.Time
}

func runGenerate(arguments []string) error {
	flags := flag.NewFlagSet("generate", flag.ContinueOnError)
	version := flags.String("version", "", "release version, e.g. v1.4.0")
	channel := flags.String("channel", update.DefaultChannel, "release channel")
	newDir := flags.String("new-dir", "", "directory of newly built openoutpost-<goos>-<goarch> binaries")
	previousManifest := flags.String("previous-manifest", "", "the channel's current manifest.json; omit to bootstrap a channel")
	previousBlobDir := flags.String("previous-blob-dir", "", "local mirror of the release bucket root holding the previous blobs")
	outDir := flags.String("out-dir", "", "directory to write the bucket layout into")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	return generate(generateOptions{
		version:          *version,
		channel:          *channel,
		newDir:           *newDir,
		previousManifest: *previousManifest,
		previousBlobDir:  *previousBlobDir,
		outDir:           *outDir,
	})
}

func generate(options generateOptions) error {
	if options.version == "" || options.newDir == "" || options.outDir == "" {
		return errors.New("generate requires --version, --new-dir and --out-dir")
	}
	if options.channel == "" {
		options.channel = update.DefaultChannel
	}
	if options.generatedAt.IsZero() {
		options.generatedAt = time.Now().UTC()
	}

	binaries, err := readNewBinaries(options.newDir)
	if err != nil {
		return err
	}
	if len(binaries) == 0 {
		return fmt.Errorf("no %s<goos>-<goarch> binaries found in %s", binaryPrefix, options.newDir)
	}

	previous, err := readPreviousManifest(options.previousManifest)
	if err != nil {
		return err
	}

	manifest := update.Manifest{
		SchemaVersion: update.SchemaVersion,
		Channel:       options.channel,
		GeneratedAt:   options.generatedAt.UTC().Truncate(time.Second),
		Latest: update.Latest{
			Version:   options.version,
			Platforms: map[string]update.PlatformArtifact{},
		},
	}
	// A manifest that is not strictly newer than the one it replaces would be
	// refused by every worker that already accepted the old one.
	if previous != nil && !manifest.GeneratedAt.After(previous.GeneratedAt) {
		manifest.GeneratedAt = previous.GeneratedAt.Add(time.Second)
	}

	for platform, content := range binaries {
		key := blobKey(options.version, platform)
		if err := writeObject(options.outDir, key, content); err != nil {
			return err
		}
		manifest.Latest.Platforms[platform] = update.PlatformArtifact{
			URL:    key,
			SHA256: digestOf(content),
			Size:   int64(len(content)),
		}
	}

	patches := make([]update.PatchEntry, 0)
	if previous != nil {
		fresh, err := diffAgainstPrevious(options, *previous, binaries)
		if err != nil {
			return err
		}
		patches = append(patches, fresh...)
		patches = append(patches, previous.Patches...)
	}
	manifest.Patches = pruneHistory(patches, manifest.Latest.Platforms)

	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode manifest: %w", err)
	}
	encoded = append(encoded, '\n')
	if err := manifest.Validate(); err != nil {
		return err
	}
	return writeObject(options.outDir, manifestKey(options.channel), encoded)
}

// readNewBinaries loads every cross-built worker in a directory, keyed by the
// platform its filename names.
func readNewBinaries(directory string) (map[string][]byte, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("read build directory: %w", err)
	}
	binaries := map[string][]byte{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), binaryPrefix) {
			continue
		}
		platform := strings.TrimPrefix(entry.Name(), binaryPrefix)
		content, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", entry.Name(), err)
		}
		binaries[platform] = content
	}
	return binaries, nil
}

// readPreviousManifest loads the channel's current manifest. It is our own
// prior output rather than something downloaded from the network, so it is
// parsed directly — but still validated, because a corrupted one would
// otherwise be carried straight into the next release.
func readPreviousManifest(path string) (*update.Manifest, error) {
	if path == "" {
		return nil, nil
	}
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read previous manifest: %w", err)
	}
	if len(bytes.TrimSpace(content)) == 0 {
		return nil, nil
	}
	var manifest update.Manifest
	if err := json.Unmarshal(content, &manifest); err != nil {
		return nil, fmt.Errorf("decode previous manifest: %w", err)
	}
	if err := manifest.Validate(); err != nil {
		return nil, fmt.Errorf("previous manifest is not valid: %w", err)
	}
	return &manifest, nil
}

// diffAgainstPrevious produces one hop per platform present in both releases.
// A platform the previous release did not ship simply has no patch, and its
// workers take the full download.
func diffAgainstPrevious(
	options generateOptions,
	previous update.Manifest,
	binaries map[string][]byte,
) ([]update.PatchEntry, error) {
	if options.previousBlobDir == "" {
		return nil, nil
	}
	entries := make([]update.PatchEntry, 0, len(binaries))
	platforms := make([]string, 0, len(binaries))
	for platform := range binaries {
		platforms = append(platforms, platform)
	}
	sort.Strings(platforms)

	for _, platform := range platforms {
		artifact, ok := previous.Latest.Platforms[platform]
		if !ok {
			continue
		}
		oldContent, err := os.ReadFile(filepath.Join(options.previousBlobDir, filepath.FromSlash(artifact.URL)))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("read the previous %s binary: %w", platform, err)
		}
		if digestOf(oldContent) != artifact.SHA256 {
			return nil, fmt.Errorf("the previous %s binary does not match its manifest digest", platform)
		}

		var patch bytes.Buffer
		newContent := binaries[platform]
		if err := binarydist.Diff(bytes.NewReader(oldContent), bytes.NewReader(newContent), &patch); err != nil {
			return nil, fmt.Errorf("diff %s: %w", platform, err)
		}
		key := patchKey(previous.Latest.Version, options.version, platform)
		if err := writeObject(options.outDir, key, patch.Bytes()); err != nil {
			return nil, err
		}
		entries = append(entries, update.PatchEntry{
			Platform:    platform,
			FromVersion: previous.Latest.Version,
			FromSHA256:  artifact.SHA256,
			ToVersion:   options.version,
			ToSHA256:    digestOf(newContent),
			URL:         key,
			PatchSHA256: digestOf(patch.Bytes()),
			PatchSize:   int64(patch.Len()),
		})
	}
	return entries, nil
}

// pruneHistory keeps the patch entries a worker could still walk: those within
// MaxManifestPatchHistory hops back from the latest build. Anything older
// describes a binary no reachable chain starts from, and only makes the
// manifest bigger.
func pruneHistory(entries []update.PatchEntry, latest map[string]update.PlatformArtifact) []update.PatchEntry {
	kept := make([]update.PatchEntry, 0, len(entries))
	seenEntry := map[string]bool{}

	platforms := make([]string, 0, len(latest))
	for platform := range latest {
		platforms = append(platforms, platform)
	}
	sort.Strings(platforms)

	for _, platform := range platforms {
		byTo := map[string][]update.PatchEntry{}
		for _, entry := range entries {
			if entry.Platform == platform {
				byTo[entry.ToSHA256] = append(byTo[entry.ToSHA256], entry)
			}
		}
		frontier := []string{latest[platform].SHA256}
		visited := map[string]bool{frontier[0]: true}
		for hop := 0; hop < update.MaxManifestPatchHistory && len(frontier) > 0; hop++ {
			next := make([]string, 0, len(frontier))
			for _, digest := range frontier {
				for _, entry := range byTo[digest] {
					identity := entry.Platform + "\x00" + entry.FromSHA256 + "\x00" + entry.ToSHA256
					if !seenEntry[identity] {
						seenEntry[identity] = true
						kept = append(kept, entry)
					}
					if !visited[entry.FromSHA256] {
						visited[entry.FromSHA256] = true
						next = append(next, entry.FromSHA256)
					}
				}
			}
			frontier = next
		}
	}

	sort.SliceStable(kept, func(first, second int) bool {
		if kept[first].Platform != kept[second].Platform {
			return kept[first].Platform < kept[second].Platform
		}
		if kept[first].ToVersion != kept[second].ToVersion {
			return kept[first].ToVersion < kept[second].ToVersion
		}
		return kept[first].FromVersion < kept[second].FromVersion
	})
	return kept
}

func writeObject(outDir, key string, content []byte) error {
	path := filepath.Join(outDir, filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", key, err)
	}
	return nil
}

func digestOf(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}
