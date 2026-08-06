package ops

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/protocol"
)

const (
	defaultGrepMatches = 200
	defaultFindResults = 500
	maxGrepFileBytes   = 1_048_576
	maxGrepLineChars   = 500
	binarySniffBytes   = 8_000
)

type grepInput struct {
	Pattern    string `json:"pattern"`
	Path       string `json:"path,omitempty"`
	MaxMatches int    `json:"maxMatches,omitempty"`
}

type grepMatch struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

type grepResult struct {
	Matches   []grepMatch `json:"matches"`
	Truncated bool        `json:"truncated"`
}

func (x Executor) grep(ctx context.Context, workspace string, raw json.RawMessage) (any, error) {
	var input grepInput
	if err := decodeInput(raw, &input); err != nil {
		return nil, err
	}
	if input.Pattern == "" {
		return nil, errorf(protocol.ErrInvalidInput, "pattern is required")
	}
	pattern, err := regexp.Compile(input.Pattern)
	if err != nil {
		return nil, errorf(protocol.ErrInvalidInput, "invalid pattern: %v", err)
	}
	maxMatches := defaultGrepMatches
	if input.MaxMatches > 0 {
		maxMatches = min(input.MaxMatches, 1_000)
	}

	root, err := resolvePath(workspace, input.Path)
	if err != nil {
		return nil, err
	}

	searchPath := input.Path
	if searchPath == "" {
		searchPath = "."
	}

	matches := make([]grepMatch, 0, 16)
	truncated := false
	walkErr := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if walkErr != nil {
			// One unreadable entry deep in a tree is not the search failing,
			// but a root that cannot be walked is: an empty match list is
			// otherwise indistinguishable from the pattern being absent.
			if path == root {
				return walkErr
			}
			return nil
		}
		if entry.IsDir() {
			if entry.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		if info, infoErr := entry.Info(); infoErr != nil || info.Size() > maxGrepFileBytes {
			return nil
		}

		fileMatches, fileErr := grepFile(path, pattern, maxMatches-len(matches))
		if fileErr != nil {
			return nil
		}
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		if input.Path != "" {
			relative = filepath.Join(input.Path, relative)
		}
		for _, match := range fileMatches {
			match.Path = filepath.ToSlash(relative)
			matches = append(matches, match)
		}
		if len(matches) >= maxMatches {
			truncated = true
			return filepath.SkipAll
		}
		return nil
	})
	if walkErr != nil {
		if ctx.Err() != nil {
			return nil, errorf(protocol.ErrTimeout, "grep cancelled")
		}
		return nil, errorf(protocol.ErrExecution, "grep %q: %v", searchPath, walkErr)
	}

	return grepResult{Matches: matches, Truncated: truncated}, nil
}

func grepFile(path string, pattern *regexp.Regexp, limit int) ([]grepMatch, error) {
	if limit <= 0 {
		return nil, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	sniff := make([]byte, binarySniffBytes)
	n, _ := file.Read(sniff)
	if bytes.IndexByte(sniff[:n], 0) >= 0 {
		return nil, nil
	}
	if _, err := file.Seek(0, 0); err != nil {
		return nil, err
	}

	var matches []grepMatch
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), maxGrepFileBytes)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		text := scanner.Text()
		if !pattern.MatchString(text) {
			continue
		}
		if len(text) > maxGrepLineChars {
			text = text[:maxGrepLineChars]
		}
		matches = append(matches, grepMatch{Line: lineNumber, Text: text})
		if len(matches) >= limit {
			break
		}
	}
	return matches, nil
}

type findInput struct {
	Glob       string `json:"glob"`
	MaxResults int    `json:"maxResults,omitempty"`
}

type findResult struct {
	Paths     []string `json:"paths"`
	Truncated bool     `json:"truncated"`
}

func (x Executor) find(ctx context.Context, workspace string, raw json.RawMessage) (any, error) {
	var input findInput
	if err := decodeInput(raw, &input); err != nil {
		return nil, err
	}
	if input.Glob == "" {
		return nil, errorf(protocol.ErrInvalidInput, "glob is required")
	}
	pattern, err := globToRegexp(input.Glob)
	if err != nil {
		return nil, errorf(protocol.ErrInvalidInput, "invalid glob: %v", err)
	}
	maxResults := defaultFindResults
	if input.MaxResults > 0 {
		maxResults = min(input.MaxResults, 5_000)
	}

	root, err := resolvePath(workspace, ".")
	if err != nil {
		return nil, err
	}

	paths := make([]string, 0, 16)
	truncated := false
	walkErr := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if walkErr != nil {
			// As in grep: a root that cannot be walked is a failed search, an
			// unreadable entry inside it is not.
			if path == root {
				return walkErr
			}
			return nil
		}
		if entry.IsDir() {
			if entry.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		relative = filepath.ToSlash(relative)
		if !pattern.MatchString(relative) {
			return nil
		}
		paths = append(paths, relative)
		if len(paths) >= maxResults {
			truncated = true
			return filepath.SkipAll
		}
		return nil
	})
	if walkErr != nil {
		if ctx.Err() != nil {
			return nil, errorf(protocol.ErrTimeout, "find cancelled")
		}
		return nil, errorf(protocol.ErrExecution, "find %q: %v", input.Glob, walkErr)
	}

	return findResult{Paths: paths, Truncated: truncated}, nil
}

// globToRegexp supports *, ?, and ** with the usual meaning: * and ? never
// cross a path separator, ** does. A glob without a slash matches basenames
// anywhere in the tree.
func globToRegexp(glob string) (*regexp.Regexp, error) {
	if !strings.Contains(glob, "/") {
		glob = "**/" + glob
	}
	var builder strings.Builder
	builder.WriteString("^")
	for i := 0; i < len(glob); i++ {
		switch glob[i] {
		case '*':
			if i+1 < len(glob) && glob[i+1] == '*' {
				if i+2 < len(glob) && glob[i+2] == '/' {
					builder.WriteString(`(?:[^/]+/)*`)
					i += 2
				} else {
					builder.WriteString(`.*`)
					i++
				}
			} else {
				builder.WriteString(`[^/]*`)
			}
		case '?':
			builder.WriteString(`[^/]`)
		default:
			builder.WriteString(regexp.QuoteMeta(string(glob[i])))
		}
	}
	builder.WriteString("$")
	return regexp.Compile(builder.String())
}
