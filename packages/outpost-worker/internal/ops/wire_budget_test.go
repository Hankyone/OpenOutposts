package ops

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestWireStringBudgetMatchesEncodingJSON(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		chunks [][]byte
	}{
		{name: "ascii", chunks: [][]byte{[]byte("plain text")}},
		{name: "quotes and slashes", chunks: [][]byte{[]byte("\"\\")}},
		{name: "controls", chunks: [][]byte{{0, '\n', '\r', '\t', 0x1f}}},
		{name: "invalid utf8", chunks: [][]byte{{0xff, 0xfe}}},
		{name: "html sensitive", chunks: [][]byte{[]byte("<>&")}},
		{name: "line separators", chunks: [][]byte{[]byte("\u2028\u2029")}},
		{name: "split rune", chunks: [][]byte{{0xe4}, {0xb8}, {0x96}}},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			buffer := &cappedBuffer{limit: 1 << 20}
			for _, chunk := range test.chunks {
				if _, err := buffer.Write(chunk); err != nil {
					t.Fatal(err)
				}
			}
			retained := buffer.string()
			encoded, err := json.Marshal(retained)
			if err != nil {
				t.Fatal(err)
			}
			if got, want := buffer.spent, len(encoded)-2; got != want {
				t.Fatalf("charged %d bytes, encoding/json wrote %d", got, want)
			}
			if buffer.truncated {
				t.Fatal("input unexpectedly truncated")
			}
		})
	}
}

func TestWireStringBudgetHonoursRawLimitWithoutSplittingRune(t *testing.T) {
	t.Parallel()

	buffer := &cappedBuffer{limit: 64, rawLimit: 4}
	if _, err := buffer.Write([]byte("a世b")); err != nil {
		t.Fatal(err)
	}
	if got := buffer.string(); got != "a世" {
		t.Fatalf("retained %q, want one complete multibyte rune", got)
	}
	if !buffer.truncated || buffer.rawSpent != 4 {
		t.Fatalf("truncated=%v rawSpent=%d", buffer.truncated, buffer.rawSpent)
	}
}

func TestJSONArrayBudgetAcceptsExactFitAndRejectsNextItem(t *testing.T) {
	t.Parallel()

	type arrayResult struct {
		Items     []string `json:"items"`
		Truncated bool     `json:"truncated"`
	}
	empty := arrayResult{Items: []string{}, Truncated: false}
	emptyJSON, err := json.Marshal(empty)
	if err != nil {
		t.Fatal(err)
	}
	item := "<quoted> & complete"
	itemJSON, err := json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	budget, err := newJSONArrayBudget(len(emptyJSON)+len(itemJSON), empty)
	if err != nil {
		t.Fatal(err)
	}
	if fits, err := budget.add(item); err != nil || !fits {
		t.Fatalf("exact-fit item: fits=%v err=%v", fits, err)
	}
	if budget.spent != budget.limit {
		t.Fatalf("spent %d bytes, want exact %d", budget.spent, budget.limit)
	}
	if fits, err := budget.add("x"); err != nil || fits {
		t.Fatalf("over-budget item: fits=%v err=%v", fits, err)
	}
}

func TestGrepLineLimitDoesNotSplitUTF8Rune(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "utf8.txt")
	line := strings.Repeat("a", maxGrepLineChars-1) + "世"
	if err := os.WriteFile(path, []byte(line+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	matches, err := grepFile(path, regexp.MustCompile("a"), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 || !utf8.ValidString(matches[0].Text) {
		t.Fatalf("grep split a UTF-8 rune: %#v", matches)
	}
	if matches[0].Text != strings.Repeat("a", maxGrepLineChars-1) {
		t.Fatalf("unexpected bounded line length %d", len(matches[0].Text))
	}
}
