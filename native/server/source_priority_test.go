package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
	"testing"
)

func TestLargeFrameOwnsAnalysisLeaseUntilNotificationCommits(t *testing.T) {
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": map[string]any{"textDocument": map[string]any{"uri": "file:///original/startup.txt", "languageId": "choicescript", "version": 1, "text": strings.Repeat("Original narrative.\n", 70000)}}})
	if err != nil {
		t.Fatal(err)
	}
	frame := fmt.Sprintf("Content-Length: %d\r\n\r\n", len(body)) + string(body)
	stream := newRPC(strings.NewReader(frame), io.Discard)
	stream.textDirectory = t.TempDir()
	defer stream.captures.close()
	var active atomic.Int32
	stream.sourceReadStarted = func() func() { active.Add(1); return func() { active.Add(-1) } }
	message, err := stream.read()
	if err != nil {
		t.Fatal(err)
	}
	if active.Load() != 1 || message.Sources["/params/textDocument/text"] == nil {
		t.Fatal("capture lease ended before notification")
	}
	message.finishSourceRead()
	message.finishSourceRead()
	if active.Load() != 0 {
		t.Fatal("source lease was not released exactly once")
	}
}
func TestInvalidLargeFrameReleasesAnalysisLease(t *testing.T) {
	body := strings.Repeat(" ", 1024*1024) + "invalid"
	stream := newRPC(strings.NewReader(fmt.Sprintf("Content-Length: %d\r\n\r\n%s", len(body), body)), io.Discard)
	stream.textDirectory = t.TempDir()
	defer stream.captures.close()
	var active atomic.Int32
	stream.sourceReadStarted = func() func() { active.Add(1); return func() { active.Add(-1) } }
	if _, err := stream.read(); err == nil {
		t.Fatal("invalid frame accepted")
	}
	if active.Load() != 0 {
		t.Fatal("invalid frame blocked future analysis")
	}
}
func TestIncomingSourcePreservesValidDiskWorkAndReleasesOnce(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := &nativeServer{changed: make(chan struct{}), wake: make(chan struct{}, 1), activeCancel: cancel}
	finish := server.beginSourceRead()
	if server.receivingSources != 1 || ctx.Err() != nil {
		t.Fatal("incoming source cancelled a still-valid snapshot")
	}
	finish()
	finish()
	if server.receivingSources != 0 {
		t.Fatal("incoming source count underflowed")
	}
}
