package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

type semanticTokenResponse struct {
	context  context.Context
	tokens   []core.Token
	sequence core.TokenSequence
}

// Semantic data stays in its immutable query snapshot. A sizing pass supplies
// the LSP Content-Length; a bounded writer emits exactly the same five-value
// deltas without allocating another integer arena and whole-message JSON buffer.
func (s *rpcStream) respondTokens(id json.RawMessage, result semanticTokenResponse) error {
	prefix := []byte(`{"jsonrpc":"2.0","id":`)
	prefix = append(prefix, id...)
	prefix = append(prefix, []byte(`,"result":{"data":[`)...)
	const suffix = "]}}"
	length := int64(len(prefix) + len(suffix))
	tokens := result.sequence
	if tokens.Len() == 0 {
		tokens = core.DenseTokenSequence(result.tokens)
	}
	var previousLine, previousColumn uint32
	for index, token := range tokens.All() {
		if index&1023 == 0 {
			if err := result.context.Err(); err != nil {
				return s.respond(id, nil, err)
			}
		}
		values := semanticDelta(token, previousLine, previousColumn)
		for _, value := range values {
			length += int64(decimalLength(value))
		}
		previousLine, previousColumn = token.Line, token.Start
	}
	if tokens.Len() > 0 {
		length += int64(tokens.Len())*5 - 1
	}
	if err := result.context.Err(); err != nil {
		return s.respond(id, nil, err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	output := bufio.NewWriterSize(s.writer, 65536)
	if _, err := fmt.Fprintf(output, "Content-Length: %d\r\n\r\n", length); err != nil {
		return err
	}
	if _, err := output.Write(prefix); err != nil {
		return err
	}
	buffer := make([]byte, 0, 65536)
	previousLine, previousColumn = 0, 0
	first := true
	for _, token := range tokens.All() {
		values := semanticDelta(token, previousLine, previousColumn)
		for _, value := range values {
			if len(buffer)+11 > cap(buffer) {
				if _, err := output.Write(buffer); err != nil {
					return err
				}
				buffer = buffer[:0]
			}
			if !first {
				buffer = append(buffer, ',')
			}
			first = false
			buffer = strconv.AppendUint(buffer, uint64(value), 10)
		}
		previousLine, previousColumn = token.Line, token.Start
	}
	if _, err := output.Write(buffer); err != nil {
		return err
	}
	if _, err := output.WriteString(suffix); err != nil {
		return err
	}
	return output.Flush()
}
func semanticDelta(token core.Token, line, column uint32) [5]uint32 {
	delta := token.Line - line
	position := token.Start
	if delta == 0 {
		position -= column
	}
	return [5]uint32{delta, position, token.Length, uint32(token.Type), uint32(token.Modifiers)}
}
func decimalLength(value uint32) int {
	length := 1
	for value >= 10 {
		value /= 10
		length++
	}
	return length
}
