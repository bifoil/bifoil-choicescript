package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestNativeRPCFramingAndBorrowedPayload(t *testing.T) {
	text := strings.Repeat("😀 original ", 10000)
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": "request", "method": "example", "params": map[string]string{"text": text}})
	framed := append([]byte(fmt.Sprintf("Content-Length: %d\r\n\r\n", len(body))), body...)
	input := append(append([]byte(nil), framed...), framed...)
	stream := newRPC(bytes.NewReader(input), new(bytes.Buffer))
	first, err := stream.read()
	if err != nil {
		t.Fatal(err)
	}
	second, err := stream.read()
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct{ Text string }
	if err = json.Unmarshal(first.Params, &decoded); err != nil || decoded.Text != text {
		t.Fatal("a later frame invalidated its predecessor", err)
	}
	if !bytes.Equal(first.Params, second.Params) {
		t.Fatal("framing changed source bytes")
	}
	for _, header := range []string{"Content-Length: -1\r\n\r\n", "Content-Length: 1\r\nContent-Length: 1\r\n\r\n{}", "Content-Type: x\r\n\r\n", "Content-Length: 40\r\n\r\n{}"} {
		if _, err = newRPC(strings.NewReader(header), new(bytes.Buffer)).read(); err == nil {
			t.Fatal("invalid frame accepted", header)
		}
	}
}
