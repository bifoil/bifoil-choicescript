package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"reflect"
	"testing"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

func TestStreamedSemanticResponsePreservesFramingAndEveryDelta(t *testing.T) {
	for _, count := range []int{0, 1, 30000} {
		tokens := make([]core.Token, count)
		for i := range tokens {
			tokens[i] = core.Token{Line: uint32(i / 3), Start: uint32(i%3) * 100, Length: uint32(1 + i%91), Type: uint8(i % 16), Modifiers: uint8(i % 4)}
		}
		p := &core.Project{Tokens: [][]core.Token{tokens}}
		for _, id := range []json.RawMessage{json.RawMessage("42"), json.RawMessage(`"original\\identifier"`)} {
			var output bytes.Buffer
			stream := newRPC(bytes.NewReader(nil), &output)
			if err := stream.respond(id, semanticTokenResponse{context: context.Background(), tokens: tokens}, nil); err != nil {
				t.Fatal(err)
			}
			input := newRPC(&output, io.Discard)
			response, err := input.read()
			if err != nil {
				t.Fatal(err)
			}
			var decoded struct{ Data []uint32 }
			if err = json.Unmarshal(response.Result, &decoded); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(id, response.ID) || !reflect.DeepEqual(decoded.Data, p.EncodeTokens(0)) {
				t.Fatal("semantic response lost or changed deltas")
			}
			if output.Len() != 0 {
				t.Fatal("content length left unframed bytes")
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var output bytes.Buffer
	if err := newRPC(bytes.NewReader(nil), &output).respond(json.RawMessage("1"), semanticTokenResponse{context: ctx}, nil); err != nil {
		t.Fatal(err)
	}
	response, err := newRPC(&output, io.Discard).read()
	if err != nil || response.Error == nil || response.Error.Code != -32800 {
		t.Fatal("cancellation emitted partial semantic output", err)
	}
}
