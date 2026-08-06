// Package picontext discovers the project instructions a normal Pi process
// would see when started in a leased outpost workspace.
package picontext

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	// MaxBytes bounds the raw prompt input. The client separately checks the
	// encoded result, because JSON escaping can make a byte much larger on the
	// wire than it is in the source file.
	MaxBytes = 512 * 1024
	MaxFiles = 64
)

var candidateNames = []string{"AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"}

type File struct {
	Path    string
	Content string
}

// Discover loads at most one context file from each directory between the
// configured workspace root and the leased workspace, ordered from broadest to
// most specific. Paths are virtual labels: the model learns the instruction
// hierarchy without learning host filesystem paths it cannot use.
func Discover(workspaceRoot, workspace string) ([]File, []string, error) {
	root, err := filepath.EvalSymlinks(filepath.Clean(workspaceRoot))
	if err != nil {
		return nil, nil, fmt.Errorf("configured workspace root cannot be resolved")
	}
	cwd, err := filepath.EvalSymlinks(filepath.Clean(workspace))
	if err != nil {
		return nil, nil, fmt.Errorf("leased workspace cannot be resolved")
	}
	relative, err := filepath.Rel(root, cwd)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return nil, nil, fmt.Errorf("workspace is outside its configured root")
	}

	directories := []string{root}
	if relative != "." {
		current := root
		for _, part := range strings.Split(relative, string(filepath.Separator)) {
			current = filepath.Join(current, part)
			directories = append(directories, current)
		}
	}

	files := make([]File, 0, len(directories))
	warnings := make([]string, 0)
	totalBytes := 0
	for _, directory := range directories {
		for _, name := range candidateNames {
			path := filepath.Join(directory, name)
			content, readErr := readWithinRoot(root, path)
			if os.IsNotExist(readErr) {
				continue
			}
			virtualPath := virtualPath(root, path)
			if readErr != nil {
				warnings = append(warnings, fmt.Sprintf("could not read %s", virtualPath))
				continue
			}
			if len(files) == MaxFiles {
				return nil, warnings, fmt.Errorf("workspace context exceeds the %d-file limit", MaxFiles)
			}
			if len(content) > MaxBytes-totalBytes {
				return nil, warnings, fmt.Errorf("workspace context exceeds the %d-byte limit", MaxBytes)
			}
			files = append(files, File{Path: virtualPath, Content: string(content)})
			totalBytes += len(content)
			break
		}
	}
	return files, warnings, nil
}

func readWithinRoot(root, path string) ([]byte, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	if resolved != root && !strings.HasPrefix(resolved, root+string(filepath.Separator)) {
		return nil, fmt.Errorf("context file escapes the configured workspace root")
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("context path is not a regular file")
	}
	return os.ReadFile(resolved)
}

func virtualPath(root, path string) string {
	relative, err := filepath.Rel(root, path)
	if err != nil {
		return "outpost:/context"
	}
	return "outpost:/" + filepath.ToSlash(relative)
}
