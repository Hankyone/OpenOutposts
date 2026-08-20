package ops

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/protocol"
)

const (
	maxReadBytes = 262_144
	// read streams, so this bounds how much disk one call may walk rather than
	// how much it holds; without it a sparse core dump in a leased workspace
	// keeps the operation running until the tool deadline.
	maxReadFileBytes = 16 << 20
	// edit materialises the file, its replacement and the rewritten copy, so
	// peak memory is roughly three times this. Nothing restarts the worker
	// after the kernel kills it for growing past the machine's memory.
	maxEditFileBytes = 8 << 20
	// readChunkBytes bounds the window read holds while it looks for the next
	// newline, so one enormous line cannot pull the whole file into memory.
	readChunkBytes = 64 * 1024
	// A directory listing is bounded like its siblings: grep stops at 1000
	// matches, so ls stops at 1000 entries. node_modules and build caches make
	// an unbounded listing a multi-megabyte result the control plane refuses.
	maxLsEntries = 1_000
)

type readInput struct {
	Path        string `json:"path"`
	OffsetLines int    `json:"offsetLines,omitempty"`
	LimitLines  int    `json:"limitLines,omitempty"`
}

type readResult struct {
	Content    string `json:"content"`
	TotalLines int    `json:"totalLines"`
	Truncated  bool   `json:"truncated"`
}

func (x Executor) read(workspace string, raw json.RawMessage) (any, error) {
	var input readInput
	if err := decodeInput(raw, &input); err != nil {
		return nil, err
	}
	if input.Path == "" {
		return nil, errorf(protocol.ErrInvalidInput, "path is required")
	}
	target, err := resolvePath(workspace, input.Path)
	if err != nil {
		return nil, err
	}

	file, err := os.Open(target)
	if err != nil {
		return nil, errorf(protocol.ErrExecution, "read %q: %v", input.Path, err)
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return nil, errorf(protocol.ErrExecution, "read %q: %v", input.Path, err)
	}
	if info.Mode().IsRegular() && info.Size() > maxReadFileBytes {
		return nil, errorf(
			protocol.ErrExecution,
			"read %q: %d bytes exceeds the %d byte read limit; narrow the range with bash",
			input.Path,
			info.Size(),
			maxReadFileBytes,
		)
	}

	// The file is split on "\n" exactly as strings.Split would: a file with n
	// newlines has n+1 parts, the last of them empty when the file ends in a
	// newline. Parts are streamed so only the returned window is ever held.
	firstPart := input.OffsetLines
	lastPart := math.MaxInt
	if input.LimitLines > 0 && firstPart <= math.MaxInt-input.LimitLines {
		lastPart = firstPart + input.LimitLines
	}

	// Reserve the complete fixed read-result shape before spending bytes on
	// content. math.MaxInt is deliberately used for totalLines so the actual
	// integer can never make the final result larger than this base.
	emptyResult, err := json.Marshal(readResult{Content: "", TotalLines: math.MaxInt, Truncated: false})
	if err != nil {
		return nil, errorf(protocol.ErrExecution, "prepare read result budget: %v", err)
	}
	content := &cappedBuffer{
		limit:    protocol.MaxToolOutputBytes - len(emptyResult),
		rawLimit: maxReadBytes,
	}
	partIndex := 0
	totalLines := 1
	partsWritten := 0
	partOpen := false
	truncated := input.OffsetLines > 0

	appendBytes := func(text []byte) {
		_, _ = content.Write(text)
	}
	appendPart := func(text []byte) {
		if partIndex < firstPart || partIndex >= lastPart {
			return
		}
		if !partOpen {
			partOpen = true
			if partsWritten > 0 {
				appendBytes([]byte("\n"))
			}
			partsWritten++
		}
		appendBytes(text)
	}

	reader := bufio.NewReaderSize(file, readChunkBytes)
	for {
		chunk, readErr := reader.ReadSlice('\n')
		switch {
		case readErr == nil:
			appendPart(chunk[:len(chunk)-1])
			partIndex++
			totalLines++
			partOpen = false
			continue
		case errors.Is(readErr, bufio.ErrBufferFull):
			appendPart(chunk)
			continue
		case errors.Is(readErr, io.EOF):
			appendPart(chunk)
		default:
			return nil, errorf(protocol.ErrExecution, "read %q: %v", input.Path, readErr)
		}
		break
	}
	if totalLines > lastPart {
		truncated = true
	}

	contentText := content.string()
	return readResult{
		Content:    contentText,
		TotalLines: totalLines,
		Truncated:  truncated || content.truncated,
	}, nil
}

type writeInput struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type writeResult struct {
	BytesWritten int  `json:"bytesWritten"`
	Created      bool `json:"created"`
}

func (x Executor) write(workspace string, raw json.RawMessage) (any, error) {
	var input writeInput
	if err := decodeInput(raw, &input); err != nil {
		return nil, err
	}
	if input.Path == "" {
		return nil, errorf(protocol.ErrInvalidInput, "path is required")
	}
	target, err := resolvePath(workspace, input.Path)
	if err != nil {
		return nil, err
	}

	leafInfo, statErr := os.Lstat(target)
	created := errors.Is(statErr, os.ErrNotExist)
	// A dangling symlink leaf would pass workspace resolution (only its
	// existing ancestors resolve) while WriteFile follows it to the link's
	// out-of-workspace destination. Never write through a symlink.
	if statErr == nil && leafInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errorf(
			protocol.ErrPathOutsideWorkspace,
			"refusing to write through the symlink at %q",
			input.Path,
		)
	}

	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return nil, errorf(protocol.ErrExecution, "create parent directories for %q: %v", input.Path, err)
	}
	if err := os.WriteFile(target, []byte(input.Content), 0o644); err != nil {
		return nil, errorf(protocol.ErrExecution, "write %q: %v", input.Path, err)
	}

	return writeResult{BytesWritten: len(input.Content), Created: created}, nil
}

type editInput struct {
	Path       string `json:"path"`
	OldString  string `json:"oldString"`
	NewString  string `json:"newString"`
	ReplaceAll bool   `json:"replaceAll,omitempty"`
}

type editResult struct {
	Replacements int `json:"replacements"`
}

func (x Executor) edit(workspace string, raw json.RawMessage) (any, error) {
	var input editInput
	if err := decodeInput(raw, &input); err != nil {
		return nil, err
	}
	if input.Path == "" || input.OldString == "" {
		return nil, errorf(protocol.ErrInvalidInput, "path and oldString are required")
	}
	if input.OldString == input.NewString {
		return nil, errorf(protocol.ErrInvalidInput, "oldString and newString are identical")
	}
	target, err := resolvePath(workspace, input.Path)
	if err != nil {
		return nil, err
	}

	info, err := os.Stat(target)
	if err != nil {
		return nil, errorf(protocol.ErrExecution, "read %q: %v", input.Path, err)
	}
	if info.Size() > maxEditFileBytes {
		return nil, errorf(
			protocol.ErrExecution,
			"edit %q: %d bytes exceeds the %d byte edit limit; rewrite it with bash",
			input.Path,
			info.Size(),
			maxEditFileBytes,
		)
	}

	data, err := os.ReadFile(target)
	if err != nil {
		return nil, errorf(protocol.ErrExecution, "read %q: %v", input.Path, err)
	}
	content := string(data)

	occurrences := strings.Count(content, input.OldString)
	if occurrences == 0 {
		return nil, errorf(protocol.ErrExecution, "oldString was not found in %q", input.Path)
	}
	if occurrences > 1 && !input.ReplaceAll {
		return nil, errorf(
			protocol.ErrExecution,
			"oldString matches %d locations in %q; provide more context or set replaceAll",
			occurrences,
			input.Path,
		)
	}

	replacements := 1
	if input.ReplaceAll {
		replacements = occurrences
		content = strings.ReplaceAll(content, input.OldString, input.NewString)
	} else {
		content = strings.Replace(content, input.OldString, input.NewString, 1)
	}

	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		return nil, errorf(protocol.ErrExecution, "write %q: %v", input.Path, err)
	}

	return editResult{Replacements: replacements}, nil
}

type lsInput struct {
	Path string `json:"path,omitempty"`
}

type lsEntry struct {
	Name      string `json:"name"`
	Type      string `json:"type"`
	SizeBytes *int64 `json:"sizeBytes,omitempty"`
}

type lsResult struct {
	Entries   []lsEntry `json:"entries"`
	Truncated bool      `json:"truncated"`
}

func (x Executor) ls(workspace string, raw json.RawMessage) (any, error) {
	var input lsInput
	if err := decodeInput(raw, &input); err != nil {
		return nil, err
	}
	target, err := resolvePath(workspace, input.Path)
	if err != nil {
		return nil, err
	}

	dirEntries, err := os.ReadDir(target)
	if err != nil {
		return nil, errorf(protocol.ErrExecution, "list %q: %v", input.Path, err)
	}

	entries := make([]lsEntry, 0, len(dirEntries))
	for _, entry := range dirEntries {
		entryType := "other"
		var size *int64
		switch {
		case entry.Type()&os.ModeSymlink != 0:
			entryType = "symlink"
		case entry.IsDir():
			entryType = "dir"
		case entry.Type().IsRegular():
			entryType = "file"
			if info, infoErr := entry.Info(); infoErr == nil {
				fileSize := info.Size()
				size = &fileSize
			}
		}
		entries = append(entries, lsEntry{Name: entry.Name(), Type: entryType, SizeBytes: size})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })

	// Sort before capping so the listing a caller pages through is stable
	// rather than whatever order the filesystem happened to return.
	budget, err := newJSONArrayBudget(
		protocol.MaxToolOutputBytes,
		lsResult{Entries: []lsEntry{}, Truncated: false},
	)
	if err != nil {
		return nil, errorf(protocol.ErrExecution, "prepare ls result budget: %v", err)
	}
	selected := make([]lsEntry, 0, min(len(entries), maxLsEntries))
	for _, entry := range entries {
		if len(selected) >= maxLsEntries {
			break
		}
		fits, budgetErr := budget.add(entry)
		if budgetErr != nil {
			return nil, errorf(protocol.ErrExecution, "encode ls entry: %v", budgetErr)
		}
		if !fits {
			break
		}
		selected = append(selected, entry)
	}

	return lsResult{Entries: selected, Truncated: len(selected) < len(entries)}, nil
}
