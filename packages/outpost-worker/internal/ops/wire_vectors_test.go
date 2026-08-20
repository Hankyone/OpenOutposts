package ops

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"testing"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/protocol"
)

type opsWireFixture struct {
	FixtureVersion  int                    `json:"fixtureVersion"`
	Description     string                 `json:"description"`
	ProtocolVersion int                    `json:"protocolVersion"`
	Messages        []json.RawMessage      `json:"messages"`
	ToolPayloads    []opsToolPayloadVector `json:"toolPayloads"`
}

type opsToolPayloadVector struct {
	Name               string          `json:"name"`
	Operation          string          `json:"operation"`
	RequestMessageName string          `json:"requestMessageName"`
	ResultMessageName  string          `json:"resultMessageName"`
	Input              json.RawMessage `json:"input"`
	Result             json.RawMessage `json:"result"`
}

func TestWireVectors(t *testing.T) {
	fixture := loadOpsWireFixture(t)
	if fixture.FixtureVersion != 1 {
		t.Fatalf("unsupported fixture version %d", fixture.FixtureVersion)
	}
	if fixture.ProtocolVersion != protocol.Version {
		t.Fatalf(
			"fixture protocol version %d; Go protocol version %d",
			fixture.ProtocolVersion,
			protocol.Version,
		)
	}

	seenNames := make(map[string]struct{}, len(fixture.ToolPayloads))
	seenOperations := make(map[string]struct{}, len(fixture.ToolPayloads))
	for _, vector := range fixture.ToolPayloads {
		if _, duplicate := seenNames[vector.Name]; duplicate {
			t.Fatalf("duplicate tool payload vector name %q", vector.Name)
		}
		seenNames[vector.Name] = struct{}{}
		if _, duplicate := seenOperations[vector.Operation]; duplicate {
			t.Fatalf("duplicate tool payload operation %q", vector.Operation)
		}
		seenOperations[vector.Operation] = struct{}{}

		t.Run(vector.Operation+"/input", func(t *testing.T) {
			roundTripped := roundTripOpsPayload(t, vector.Operation, true, vector.Input)
			assertSameOpsJSON(t, vector.Input, roundTripped)
		})
		t.Run(vector.Operation+"/result", func(t *testing.T) {
			roundTripped := roundTripOpsPayload(t, vector.Operation, false, vector.Result)
			assertSameOpsJSON(t, vector.Result, roundTripped)
		})
	}

	expectedOperations := append([]string(nil), Operations...)
	actualOperations := make([]string, 0, len(seenOperations))
	for operation := range seenOperations {
		actualOperations = append(actualOperations, operation)
	}
	sort.Strings(expectedOperations)
	sort.Strings(actualOperations)
	if !reflect.DeepEqual(actualOperations, expectedOperations) {
		t.Fatalf("tool operation coverage %v; expected %v", actualOperations, expectedOperations)
	}
}

func loadOpsWireFixture(t *testing.T) opsWireFixture {
	t.Helper()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate operation wire vector test source")
	}
	fixturePath := filepath.Join(
		filepath.Dir(sourceFile),
		"..", "..", "..", "outpost-protocol", "test-fixtures", "outpost-wire-vectors.json",
	)
	content, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read wire fixture: %v", err)
	}
	var fixture opsWireFixture
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("decode wire fixture: %v", err)
	}
	return fixture
}

func roundTripOpsPayload(
	t *testing.T,
	operation string,
	input bool,
	original json.RawMessage,
) []byte {
	t.Helper()
	var target any
	switch operation {
	case "bash":
		if input {
			target = &bashInput{}
		} else {
			target = &bashResult{}
		}
	case "read":
		if input {
			target = &readInput{}
		} else {
			target = &readResult{}
		}
	case "write":
		if input {
			target = &writeInput{}
		} else {
			target = &writeResult{}
		}
	case "edit":
		if input {
			target = &editInput{}
		} else {
			target = &editResult{}
		}
	case "grep":
		if input {
			target = &grepInput{}
		} else {
			target = &grepResult{}
		}
	case "find":
		if input {
			target = &findInput{}
		} else {
			target = &findResult{}
		}
	case "ls":
		if input {
			target = &lsInput{}
		} else {
			target = &lsResult{}
		}
	default:
		t.Fatalf("unknown operation %q", operation)
	}
	if err := json.Unmarshal(original, target); err != nil {
		t.Fatalf("unmarshal %s payload through production struct: %v", operation, err)
	}
	encoded, err := json.Marshal(target)
	if err != nil {
		t.Fatalf("marshal %s payload through production struct: %v", operation, err)
	}
	return encoded
}

func assertSameOpsJSON(t *testing.T, original []byte, roundTripped []byte) {
	t.Helper()
	originalValue := normalizedOpsJSON(t, original)
	roundTrippedValue := normalizedOpsJSON(t, roundTripped)
	if reflect.DeepEqual(originalValue, roundTrippedValue) {
		return
	}
	originalPretty, _ := json.MarshalIndent(originalValue, "", "  ")
	roundTrippedPretty, _ := json.MarshalIndent(roundTrippedValue, "", "  ")
	t.Fatalf(
		"semantic JSON changed during production round trip\noriginal:\n%s\nround-tripped:\n%s",
		originalPretty,
		roundTrippedPretty,
	)
}

func normalizedOpsJSON(t *testing.T, raw []byte) any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("decode normalized JSON: %v", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		t.Fatalf("JSON contains trailing data: %v", err)
	}
	return value
}
