package ops

import (
	"bytes"
	"encoding/json"
	"unicode/utf8"
)

// cappedBuffer keeps as much output as fits in both its JSON-encoded and raw
// byte limits. A zero rawLimit disables that secondary limit. It never rejects
// a write because command output still has to be drained after the retained
// prefix is full.
type cappedBuffer struct {
	buf       bytes.Buffer
	limit     int
	rawLimit  int
	spent     int
	rawSpent  int
	partial   []byte
	truncated bool
}

// jsonEscapedCost reports the bytes a decoded rune occupies inside a JSON
// string as encoding/json writes it with HTML escaping enabled.
func jsonEscapedCost(decoded rune, size int, first byte) int {
	if size == 1 {
		switch {
		case decoded == utf8.RuneError:
			return 6
		case first == '"' || first == '\\' || first == '\n' || first == '\r' || first == '\t':
			return 2
		case first < 0x20 || first == '<' || first == '>' || first == '&':
			return 6
		default:
			return 1
		}
	}
	if decoded == '\u2028' || decoded == '\u2029' {
		return 6
	}
	return size
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	accepted := len(p)
	if c.truncated {
		return accepted, nil
	}

	data := p
	if len(c.partial) > 0 {
		data = append(c.partial, p...)
		c.partial = nil
	}

	for index := 0; index < len(data); {
		// A rune straddling two writes waits for its remaining bytes rather than
		// being charged as invalid and split at the chunk boundary.
		if !utf8.FullRune(data[index:]) {
			c.partial = append([]byte(nil), data[index:]...)
			break
		}
		decoded, size := utf8.DecodeRune(data[index:])
		cost := jsonEscapedCost(decoded, size, data[index])
		if c.spent+cost > c.limit || (c.rawLimit > 0 && c.rawSpent+size > c.rawLimit) {
			c.truncated = true
			break
		}
		c.buf.Write(data[index : index+size])
		c.spent += cost
		c.rawSpent += size
		index += size
	}
	return accepted, nil
}

// string finalises the buffer. Each byte in an incomplete trailing rune is
// invalid UTF-8, which encoding/json writes as one escaped replacement rune.
func (c *cappedBuffer) string() string {
	for _, b := range c.partial {
		cost := jsonEscapedCost(utf8.RuneError, 1, b)
		if c.spent+cost > c.limit || (c.rawLimit > 0 && c.rawSpent+1 > c.rawLimit) {
			c.truncated = true
			break
		}
		c.buf.WriteByte(b)
		c.spent += cost
		c.rawSpent++
	}
	c.partial = nil
	return c.buf.String()
}

// jsonArrayBudget charges complete array items against the encoded result
// object that contains them. The base must contain an empty array and
// truncated:false; changing [] to [item] adds exactly the item bytes, and each
// later item adds one comma.
type jsonArrayBudget struct {
	limit int
	spent int
	items int
}

func newJSONArrayBudget(limit int, emptyResult any) (*jsonArrayBudget, error) {
	encoded, err := json.Marshal(emptyResult)
	if err != nil {
		return nil, err
	}
	return &jsonArrayBudget{limit: limit, spent: len(encoded)}, nil
}

func (b *jsonArrayBudget) add(candidate any) (bool, error) {
	encoded, err := json.Marshal(candidate)
	if err != nil {
		return false, err
	}
	extra := len(encoded)
	if b.items > 0 {
		extra++
	}
	if b.spent+extra > b.limit {
		return false, nil
	}
	b.spent += extra
	b.items++
	return true, nil
}
