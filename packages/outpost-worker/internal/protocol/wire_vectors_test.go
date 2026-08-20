package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"testing"
)

type wireFixture struct {
	FixtureVersion  int                 `json:"fixtureVersion"`
	Description     string              `json:"description"`
	ProtocolVersion int                 `json:"protocolVersion"`
	Messages        []wireMessageVector `json:"messages"`
	ToolPayloads    []toolPayloadVector `json:"toolPayloads"`
}

type wireMessageVector struct {
	Name      string          `json:"name"`
	Direction string          `json:"direction"`
	GoType    string          `json:"goType"`
	Message   json.RawMessage `json:"message"`
}

type toolPayloadVector struct {
	Name               string          `json:"name"`
	Operation          string          `json:"operation"`
	RequestMessageName string          `json:"requestMessageName"`
	ResultMessageName  string          `json:"resultMessageName"`
	Input              json.RawMessage `json:"input"`
	Result             json.RawMessage `json:"result"`
}

type wireMessageHeader struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
}

var wireTypesByDirection = map[string]map[string]string{
	"workerToControl": {
		"outpost.register":  "Registration",
		"outpost.heartbeat": "Heartbeat",
		"lease.accepted":    "LeaseAccepted",
		"lease.rejected":    "LeaseRejected",
		"tool.result":       "ToolResult",
		"context.result":    "ContextResult",
	},
	"controlToWorker": {
		"outpost.registered":    "ServerMessage",
		"outpost.heartbeat_ack": "ServerMessage",
		"outpost.error":         "ServerMessage",
		"lease.offer":           "ServerMessage",
		"lease.release":         "ServerMessage",
		"tool.request":          "ServerMessage",
		"tool.cancel":           "ServerMessage",
		"context.request":       "ServerMessage",
	},
}

var wireOperations = map[string]struct{}{
	"bash":  {},
	"read":  {},
	"write": {},
	"edit":  {},
	"grep":  {},
	"find":  {},
	"ls":    {},
}

func TestWireVectors(t *testing.T) {
	fixture := loadWireFixture(t)
	if fixture.FixtureVersion != 1 {
		t.Fatalf("unsupported fixture version %d", fixture.FixtureVersion)
	}
	if fixture.ProtocolVersion != Version {
		t.Fatalf("fixture protocol version %d; Go protocol version %d", fixture.ProtocolVersion, Version)
	}

	seenNames := make(map[string]struct{}, len(fixture.Messages))
	seenTypes := map[string]map[string]struct{}{
		"workerToControl": {},
		"controlToWorker": {},
	}
	messagesByName := make(map[string]json.RawMessage, len(fixture.Messages))

	for _, vector := range fixture.Messages {
		if _, duplicate := seenNames[vector.Name]; duplicate {
			t.Fatalf("duplicate message vector name %q", vector.Name)
		}
		seenNames[vector.Name] = struct{}{}

		directionTypes, knownDirection := wireTypesByDirection[vector.Direction]
		if !knownDirection {
			t.Fatalf("%s: unknown direction %q", vector.Name, vector.Direction)
		}
		var header wireMessageHeader
		if err := json.Unmarshal(vector.Message, &header); err != nil {
			t.Fatalf("%s: decode message header: %v", vector.Name, err)
		}
		expectedGoType, knownType := directionTypes[header.Type]
		if !knownType {
			t.Fatalf("%s: unknown %s message type %q", vector.Name, vector.Direction, header.Type)
		}
		if vector.GoType != expectedGoType {
			t.Fatalf("%s: goType %q; expected %q", vector.Name, vector.GoType, expectedGoType)
		}
		if header.ProtocolVersion != Version {
			t.Fatalf("%s: message protocol version %d; expected %d", vector.Name, header.ProtocolVersion, Version)
		}
		seenTypes[vector.Direction][header.Type] = struct{}{}
		messagesByName[vector.Name] = vector.Message

		t.Run("message/"+vector.Name, func(t *testing.T) {
			roundTripped, version := roundTripWireMessage(t, vector.GoType, vector.Message)
			if version != Version {
				t.Fatalf("production struct retained protocol version %d; expected %d", version, Version)
			}
			assertSameJSON(t, vector.Message, roundTripped)
		})
	}

	for direction, expectedTypes := range wireTypesByDirection {
		assertStringSet(t, "message types for "+direction, seenTypes[direction], expectedTypes)
	}

	seenOperations := make(map[string]struct{}, len(fixture.ToolPayloads))
	for _, payload := range fixture.ToolPayloads {
		if _, known := wireOperations[payload.Operation]; !known {
			t.Fatalf("%s: unknown operation %q", payload.Name, payload.Operation)
		}
		if _, duplicate := seenOperations[payload.Operation]; duplicate {
			t.Fatalf("duplicate tool payload operation %q", payload.Operation)
		}
		seenOperations[payload.Operation] = struct{}{}

		request, found := messagesByName[payload.RequestMessageName]
		if !found {
			t.Fatalf("%s: missing request message %q", payload.Name, payload.RequestMessageName)
		}
		result, found := messagesByName[payload.ResultMessageName]
		if !found {
			t.Fatalf("%s: missing result message %q", payload.Name, payload.ResultMessageName)
		}
		assertToolPayloadTiedToMessages(t, payload, request, result)
	}
	assertStringSet(t, "tool operations", seenOperations, wireOperations)
}

func loadWireFixture(t *testing.T) wireFixture {
	t.Helper()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate wire vector test source")
	}
	fixturePath := filepath.Join(
		filepath.Dir(sourceFile),
		"..", "..", "..", "outpost-protocol", "test-fixtures", "outpost-wire-vectors.json",
	)
	content, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read wire fixture: %v", err)
	}
	var fixture wireFixture
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("decode wire fixture: %v", err)
	}
	return fixture
}

func roundTripWireMessage(t *testing.T, goType string, original json.RawMessage) ([]byte, int) {
	t.Helper()
	var target any
	switch goType {
	case "Registration":
		target = &Registration{}
	case "Heartbeat":
		target = &Heartbeat{}
	case "LeaseAccepted":
		target = &LeaseAccepted{}
	case "LeaseRejected":
		target = &LeaseRejected{}
	case "ToolResult":
		target = &ToolResult{}
	case "ContextResult":
		target = &ContextResult{}
	case "ServerMessage":
		target = &ServerMessage{}
	default:
		t.Fatalf("unknown goType %q", goType)
	}
	if err := json.Unmarshal(original, target); err != nil {
		t.Fatalf("unmarshal through %s: %v", goType, err)
	}
	encoded, err := json.Marshal(target)
	if err != nil {
		t.Fatalf("marshal through %s: %v", goType, err)
	}
	return encoded, productionProtocolVersion(t, target)
}

func productionProtocolVersion(t *testing.T, value any) int {
	t.Helper()
	switch message := value.(type) {
	case *Registration:
		return message.ProtocolVersion
	case *Heartbeat:
		return message.ProtocolVersion
	case *LeaseAccepted:
		return message.ProtocolVersion
	case *LeaseRejected:
		return message.ProtocolVersion
	case *ToolResult:
		return message.ProtocolVersion
	case *ContextResult:
		return message.ProtocolVersion
	case *ServerMessage:
		return message.ProtocolVersion
	default:
		t.Fatalf("unsupported production message type %T", value)
		return 0
	}
}

func assertToolPayloadTiedToMessages(
	t *testing.T,
	payload toolPayloadVector,
	requestRaw json.RawMessage,
	resultRaw json.RawMessage,
) {
	t.Helper()
	var request struct {
		Type      string          `json:"type"`
		RequestID string          `json:"requestId"`
		Operation string          `json:"operation"`
		Input     json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(requestRaw, &request); err != nil {
		t.Fatalf("%s: decode tied request: %v", payload.Name, err)
	}
	var result struct {
		Type      string          `json:"type"`
		RequestID string          `json:"requestId"`
		OK        bool            `json:"ok"`
		Output    json.RawMessage `json:"output"`
	}
	if err := json.Unmarshal(resultRaw, &result); err != nil {
		t.Fatalf("%s: decode tied result: %v", payload.Name, err)
	}
	if request.Type != "tool.request" || request.Operation != payload.Operation {
		t.Fatalf("%s: referenced request is %q for %q", payload.Name, request.Type, request.Operation)
	}
	if result.Type != "tool.result" || !result.OK {
		t.Fatalf("%s: referenced result is not a successful tool result", payload.Name)
	}
	if request.RequestID != result.RequestID {
		t.Fatalf("%s: request id %q differs from result id %q", payload.Name, request.RequestID, result.RequestID)
	}
	assertSameJSON(t, payload.Input, request.Input)
	assertSameJSON(t, payload.Result, result.Output)
}

func assertSameJSON(t *testing.T, original []byte, roundTripped []byte) {
	t.Helper()
	originalValue := normalizedJSON(t, original)
	roundTrippedValue := normalizedJSON(t, roundTripped)
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

func normalizedJSON(t *testing.T, raw []byte) any {
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

func assertStringSet[T any](
	t *testing.T,
	label string,
	actual map[string]struct{},
	expected map[string]T,
) {
	t.Helper()
	actualNames := make([]string, 0, len(actual))
	for name := range actual {
		actualNames = append(actualNames, name)
	}
	expectedNames := make([]string, 0, len(expected))
	for name := range expected {
		expectedNames = append(expectedNames, name)
	}
	sort.Strings(actualNames)
	sort.Strings(expectedNames)
	if !reflect.DeepEqual(actualNames, expectedNames) {
		t.Fatalf("%s coverage %s; expected %s", label, fmt.Sprint(actualNames), fmt.Sprint(expectedNames))
	}
}
