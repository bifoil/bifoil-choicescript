package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

func TestManySmallOpenScenesKeepOriginalBytesAndCurrentEditsAfterSpilling(t *testing.T) {
	stream := newRPC(nil, nil)
	stream.textDirectory = t.TempDir()
	defer stream.captures.close()
	server := &nativeServer{stream: stream, buffers: make(map[string]openBuffer)}
	expected := make(map[string][32]byte)
	var supplied int64
	for i := range 18 {
		uri := fmt.Sprintf("file:///original/scene%d.txt", i)
		text := fmt.Sprintf("Ω😀 original %d\r\n", i) + strings.Repeat("Original narrative.\r\n", 24000)
		supplied += int64(len(text))
		expected[uri] = sha256.Sum256([]byte(text))
		server.buffers[uri] = openBuffer{URI: uri, Text: text, Version: 1}
		if err := server.boundOpenBuffersLocked(); err != nil {
			t.Fatal(err)
		}
	}
	var retained int64
	spilled := 0
	for uri, buffer := range server.buffers {
		retained += int64(len(buffer.Text))
		if buffer.Store != nil {
			spilled++
		}
		if sha256.Sum256([]byte(bufferContents(t, buffer))) != expected[uri] {
			t.Fatal("spilling changed source bytes")
		}
		changes := []textChange{{Range: &core.Range{Start: core.Position{Character: 1}, End: core.Position{Character: 3}}, Text: "replacement"}}
		after, err := changeBuffer(buffer, 2, changes)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(bufferContents(t, after), "Ωreplacement original") {
			t.Fatal("spilled UTF-16 edit changed source")
		}
		if sha256.Sum256([]byte(bufferContents(t, buffer))) != expected[uri] {
			t.Fatal("edit mutated the immutable baseline")
		}
	}
	if supplied <= openTextBudget || retained > openTextBudget || spilled == 0 {
		t.Fatalf("unbounded retained prose: %d of %d", retained, supplied)
	}
}
func TestFailedSpillDoesNotDiscardOpenText(t *testing.T) {
	stream := newRPC(nil, nil)
	stream.textDirectory = filepath.Join(t.TempDir(), "missing")
	defer stream.captures.close()
	source := strings.Repeat("Original.", openTextBudget/9+1)
	server := &nativeServer{stream: stream, buffers: map[string]openBuffer{"original": {Text: source, Version: 1}}}
	if err := server.boundOpenBuffersLocked(); err == nil {
		t.Fatal("missing temporary directory was ignored")
	}
	if server.buffers["original"].Text != source || server.buffers["original"].Store != nil {
		t.Fatal("failed spill discarded source")
	}
	if _, err := os.Stat(stream.textDirectory); !os.IsNotExist(err) {
		t.Fatal("failed spill unexpectedly adopted a directory")
	}
}
