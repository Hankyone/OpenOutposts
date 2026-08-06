package ops

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/protocol"
)

// encodedLen reports how many bytes a value occupies once wsjson has written
// it, which is the size the control plane measures against its frame limit.
func encodedLen(t *testing.T, value any) int {
	t.Helper()
	var buffer bytes.Buffer
	if err := json.NewEncoder(&buffer).Encode(value); err != nil {
		t.Fatal(err)
	}
	return buffer.Len()
}

func TestBashOutputCapIsMeasuredInWireBytes(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()

	// Every NUL byte becomes six bytes of JSON, so 400 KB of captured binary
	// is 2.4 MB on the wire — well past what one frame may carry.
	result, err := execute(t, workspace, "bash", map[string]any{
		"command": "head -c 400000 /dev/zero",
	})
	if err != nil {
		t.Fatal(err)
	}
	bash := result.(bashResult)
	if !bash.Truncated {
		t.Fatal("binary output was not reported as truncated")
	}
	if size := encodedLen(t, bash); size > protocol.MaxFrameBytes {
		t.Fatalf("encoded bash result is %d bytes, above the %d byte frame limit", size, protocol.MaxFrameBytes)
	}
	if size := encodedLen(t, bash.Stdout); size > maxStdoutBytes+16 {
		t.Fatalf("encoded stdout is %d bytes, above the %d byte cap", size, maxStdoutBytes)
	}
}

func TestBashKeepsPlainOutputUpToTheCap(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()

	// Plain ASCII costs one byte each, so the cap must not shrink the amount
	// of ordinary output a command may return.
	result, err := execute(t, workspace, "bash", map[string]any{
		"command": "head -c 600000 /dev/zero | tr '\\0' 'a'",
	})
	if err != nil {
		t.Fatal(err)
	}
	bash := result.(bashResult)
	if bash.Truncated {
		t.Fatal("600000 bytes of ASCII should fit the stdout cap")
	}
	if len(bash.Stdout) != 600_000 {
		t.Fatalf("expected 600000 bytes of stdout, got %d", len(bash.Stdout))
	}
}

func TestCappedBufferChargesEscapedBytesAndKeepsSplitRunes(t *testing.T) {
	t.Parallel()

	escaped := &cappedBuffer{limit: 12}
	// Two NUL bytes cost six each and exhaust the budget; the third must not
	// be retained even though only three raw bytes were written.
	if _, err := escaped.Write([]byte{0, 0, 0}); err != nil {
		t.Fatal(err)
	}
	if got := escaped.string(); got != "\x00\x00" {
		t.Fatalf("expected two retained control bytes, got %q", got)
	}
	if !escaped.truncated {
		t.Fatal("overflow was not recorded")
	}

	split := &cappedBuffer{limit: 64}
	rune := []byte("世")
	if _, err := split.Write(rune[:1]); err != nil {
		t.Fatal(err)
	}
	if _, err := split.Write(rune[1:]); err != nil {
		t.Fatal(err)
	}
	if got := split.string(); got != "世" {
		t.Fatalf("rune split across writes was mangled: %q", got)
	}
	if split.truncated {
		t.Fatal("a three byte rune must not overflow a 64 byte budget")
	}
}

func TestLsBoundsTheNumberOfEntries(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()
	for index := 0; index < maxLsEntries+25; index++ {
		name := filepath.Join(workspace, "entry-"+strconv.Itoa(100000+index))
		if err := os.WriteFile(name, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	result, err := execute(t, workspace, "ls", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	listing := result.(lsResult)
	if len(listing.Entries) != maxLsEntries {
		t.Fatalf("expected %d entries, got %d", maxLsEntries, len(listing.Entries))
	}
	if !listing.Truncated {
		t.Fatal("a capped listing must report truncation")
	}
	if listing.Entries[0].Name != "entry-100000" {
		t.Fatalf("listing was capped before sorting: first entry is %q", listing.Entries[0].Name)
	}
}

func TestLsReportsNoTruncationWhenItFits(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "only.txt"), nil, 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := execute(t, workspace, "ls", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if result.(lsResult).Truncated {
		t.Fatal("a one entry listing must not report truncation")
	}
}

// sparseFile creates a file of the given apparent size without writing its
// bytes, which is how a core dump reaches gigabytes inside a workspace.
func sparseFile(t *testing.T, path string, size int64) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := file.Truncate(size); err != nil {
		t.Fatal(err)
	}
}

func TestReadRefusesFilesAboveTheSizeLimit(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()
	sparseFile(t, filepath.Join(workspace, "core.dump"), maxReadFileBytes+1)

	_, err := execute(t, workspace, "read", map[string]any{"path": "core.dump"})
	requireOpsError(t, err, protocol.ErrExecution)
	if !strings.Contains(err.Error(), "read limit") {
		t.Fatalf("expected the error to name the read limit, got %v", err)
	}
}

func TestEditRefusesFilesAboveTheSizeLimit(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()
	sparseFile(t, filepath.Join(workspace, "huge.log"), maxEditFileBytes+1)

	_, err := execute(t, workspace, "edit", map[string]any{
		"path":      "huge.log",
		"oldString": "needle",
		"newString": "thread",
	})
	requireOpsError(t, err, protocol.ErrExecution)
	if !strings.Contains(err.Error(), "edit limit") {
		t.Fatalf("expected the error to name the edit limit, got %v", err)
	}
}

func TestReadStreamsWithoutHoldingTheWholeFile(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()

	var builder strings.Builder
	const lines = 200_000
	for index := 0; index < lines; index++ {
		builder.WriteString("line ")
		builder.WriteString(strconv.Itoa(index))
		builder.WriteByte('\n')
	}
	path := filepath.Join(workspace, "big.log")
	if err := os.WriteFile(path, []byte(builder.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := execute(t, workspace, "read", map[string]any{
		"path":        "big.log",
		"offsetLines": 199_998,
		"limitLines":  2,
	})
	if err != nil {
		t.Fatal(err)
	}
	read := result.(readResult)
	if read.Content != "line 199998\nline 199999" {
		t.Fatalf("unexpected windowed content: %q", read.Content)
	}
	// A trailing newline makes the final part an empty string, exactly as
	// splitting the file on newlines would.
	if read.TotalLines != lines+1 {
		t.Fatalf("expected %d parts, got %d", lines+1, read.TotalLines)
	}
	if !read.Truncated {
		t.Fatal("a windowed read must report truncation")
	}
}

func TestReadCapsContentAtTheOutputLimit(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()
	// One line far longer than the output cap: the reader must never hold more
	// than a chunk of it at a time and must still return exactly the cap.
	oversized := strings.Repeat("x", maxReadBytes*3)
	if err := os.WriteFile(filepath.Join(workspace, "one-line.txt"), []byte(oversized), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := execute(t, workspace, "read", map[string]any{"path": "one-line.txt"})
	if err != nil {
		t.Fatal(err)
	}
	read := result.(readResult)
	if len(read.Content) != maxReadBytes {
		t.Fatalf("expected %d bytes of content, got %d", maxReadBytes, len(read.Content))
	}
	if !read.Truncated || read.TotalLines != 1 {
		t.Fatalf("unexpected read result: truncated=%v totalLines=%d", read.Truncated, read.TotalLines)
	}
}
