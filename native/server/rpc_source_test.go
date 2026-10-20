package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"
)

func streamedMessage(t *testing.T, body string) (rpcMessage, error) {
	t.Helper()
	stream := newRPC(strings.NewReader(body), io.Discard)
	stream.textDirectory = t.TempDir()
	t.Cleanup(stream.captures.close)
	return stream.readSourceFrame(len(body))
}
func TestStreamingRPCSourceStringsMatchJSONDecoding(t *testing.T) {
	sources := []string{`"hello\r\n😀 \\\" name"`, `"\ud83d\ude00 \ud800x \udc00"`, `"\u0000\b\f\t\/"`, `"\ud800\ud800\udfff"`, `""`}
	for _, encoded := range sources {
		body := `{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///original/startup.txt","text":` + encoded + `}}}`
		message, err := streamedMessage(t, body)
		if err != nil {
			t.Fatal(err)
		}
		var expected string
		if err = json.Unmarshal([]byte(encoded), &expected); err != nil {
			t.Fatal(err)
		}
		store := message.Sources["/params/textDocument/text"]
		if store == nil {
			t.Fatal("missing captured source")
		}
		data, err := io.ReadAll(store.reader())
		if err != nil || string(data) != expected {
			t.Fatalf("%q != %q: %v", data, expected, err)
		}
	}
}
func TestStreamingRPCDuplicateMembersAndInvalidFrames(t *testing.T) {
	body := `{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"text":"old"}},"params":{"textDocument":{"text":"new"}}}`
	message, err := streamedMessage(t, body)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(message.Sources["/params/textDocument/text"].reader())
	if string(data) != "new" {
		t.Fatal(string(data))
	}
	body = `{"jsonrpc":"2.0","params":{"textDocument":{"text":"old"}},"params":{}}`
	message, err = streamedMessage(t, body)
	if err != nil || len(message.Sources) != 0 {
		t.Fatal("replaced parent retained old source", err)
	}
	for _, body := range []string{`{"jsonrpc":"2.0","params":{"textDocument":{"text":"\x"}}}`, `{"jsonrpc":"2.0","params":{"textDocument":{"text":"a` + "\n" + `b"}}}`, `{"jsonrpc":"2.0"} []`, `{"jsonrpc":"2.0","params":{"textDocument":{"text":"unterminated`} {
		if _, err = streamedMessage(t, body); err == nil {
			t.Fatal("invalid JSON accepted")
		}
	}
}
func TestLargeStandardLSPFrameAndIncrementalEdit(t *testing.T) {
	original := "*create score 1\r\n" + strings.Repeat("Original 😀 narrative.\r\n", 60000)
	params := map[string]any{"textDocument": map[string]any{"uri": "file:///original/startup.txt", "version": 1, "languageId": "choicescript", "text": original}}
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": params})
	if err != nil {
		t.Fatal(err)
	}
	frame := append([]byte(fmt.Sprintf("Content-Length: %d\r\n\r\n", len(body))), body...)
	stream := newRPC(bytes.NewReader(frame), io.Discard)
	stream.textDirectory = t.TempDir()
	t.Cleanup(stream.captures.close)
	message, err := stream.read()
	if err != nil {
		t.Fatal(err)
	}
	store := message.Sources["/params/textDocument/text"]
	if store == nil {
		t.Fatal("large standard LSP frame retained complete JSON source")
	}
	if !store.hasDigest || store.digest != sha256.Sum256([]byte(original)) {
		t.Fatal("captured source hash changed")
	}
	data, err := io.ReadAll(store.reader())
	if err != nil || string(data) != original {
		t.Fatal("source bytes changed", err)
	}
	expected, _ := physicalLineOffsets(strings.NewReader(original))
	if !reflect.DeepEqual(expected, store.lines) {
		t.Fatal("physical line index changed")
	}
}

func TestStreamingRPCMetadataPreservesJSONAndRejectsMalformedFrames(t *testing.T) {
	for _, value := range []string{`null`, `true`, `false`, `-12.5e+2`, `"escaped \\\" Ω"`, `[]`, `{}`, `[1,true,null,{"a/b~c":"original"}]`, `{"nested":{"text":"ordinary metadata"}}`} {
		body := `{"jsonrpc":"2.0","id":7,"method":"original","params":{"value":` + value + `}}`
		message, err := streamedMessage(t, body)
		if err != nil {
			t.Fatal(value, err)
		}
		var expected, actual map[string]any
		if err = json.Unmarshal([]byte(`{"value":`+value+`}`), &expected); err != nil {
			t.Fatal(err)
		}
		if err = json.Unmarshal(message.Params, &actual); err != nil || !reflect.DeepEqual(actual, expected) || len(message.Sources) != 0 {
			t.Fatal("metadata changed", value, string(message.Params), err)
		}
	}
	for _, body := range []string{
		"", `[]`, `{"jsonrpc":"1.0"}`, `{"jsonrpc":"2.0",}`, `{"jsonrpc" "2.0"}`, `{"jsonrpc":"2.0" "params":{}}`,
		`{"jsonrpc":"2.0","params":[1 2]}`, `{"jsonrpc":"2.0","params":{"value":tru}}`,
		`{"jsonrpc":"2.0","params":{"value":"unfinished}`, `{"jsonrpc":"2.0","params":{"textDocument":{"text":"\uZZZZ"}}}`,
		`{"jsonrpc":"2.0","params":{"textDocument":{"text":"\u123"}}}`, `{"jsonrpc":"2.0","params":{"textDocument":{"text":"\`,
	} {
		if _, err := streamedMessage(t, body); err == nil {
			t.Fatal("malformed JSON-RPC accepted", body)
		}
	}
	// Metadata has a fixed cap even though streamed source strings can be much larger.
	huge := `{"jsonrpc":"2.0","method":"` + strings.Repeat("x", 16*1024*1024) + `"}`
	if _, err := streamedMessage(t, huge); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatal("metadata string cap was not enforced", err)
	}
}

func TestStreamingRPCRejectsEveryTruncatedPrefixAndMismatchedLength(t *testing.T) {
	body := `{"jsonrpc":"2.0","method":"textDocument/didChange","params":{"textDocument":{"uri":"file:///original/startup.txt"},"contentChanges":[{"text":"Original \u03a9 source\n*ending"}]}}`
	for cut := range len(body) {
		if _, err := streamedMessage(t, body[:cut]); err == nil {
			t.Fatalf("accepted truncated prefix %d/%d", cut, len(body))
		}
	}
	frame := newRPC(strings.NewReader(body), io.Discard)
	frame.textDirectory = t.TempDir()
	defer frame.captures.close()
	if _, err := frame.readSourceFrame(len(body) + 1); err == nil {
		t.Fatal("Content-Length mismatch was accepted")
	}
	message, err := streamedMessage(t, body+" \r\n\t")
	if err != nil || message.Sources["/params/contentChanges/0/text"] == nil {
		t.Fatal("valid trailing whitespace or change capture was lost", err)
	}
}
