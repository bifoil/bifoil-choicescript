package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

type observedPipeWriter struct {
	io.WriteCloser
	entered chan struct{}
	once    sync.Once
}

func (w *observedPipeWriter) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.entered) })
	return w.WriteCloser.Write(p)
}

func TestBlockedToolPipeCannotHoldEditsOrCancellation(t *testing.T) {
	reader, writer := io.Pipe()
	observed := &observedPipeWriter{WriteCloser: writer, entered: make(chan struct{})}
	p := &toolProcess{stream: observed, done: make(chan struct{}), outgoing: make(chan toolOutbound), staleWake: make(chan struct{}, 1), dirtyProjects: make(map[string]bool), writerDone: make(chan struct{}), replies: make(map[uint64]chan toolReply)}
	go p.writeLoop()
	defer func() {
		_ = reader.Close()
		_ = writer.Close()
		close(p.done)
		select {
		case <-p.writerDone:
		case <-time.After(time.Second):
			t.Error("tool writer did not stop")
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { _, err := p.call(ctx, "job", map[string]string{"original": "fixture"}); result <- err }()
	select {
	case <-observed.entered:
	case <-time.After(time.Second):
		t.Fatal("pipe write did not begin")
	}
	bridge := &toolBridge{process: p}
	edited := make(chan struct{})
	go func() {
		for range 10000 {
			bridge.stale("original-project")
		}
		close(edited)
	}()
	select {
	case <-edited:
	case <-time.After(time.Second):
		t.Fatal("edits waited on blocked tool pipe")
	}
	p.mu.Lock()
	queued := len(p.dirtyProjects)
	p.mu.Unlock()
	if queued != 1 {
		t.Fatalf("repeated edits were not coalesced: %d", queued)
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("blocked pipe prevented cancellation")
	}
	second, stop := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer stop()
	if _, err := p.call(second, "job", nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}

func TestToolCommandMustBeAdvertisedAndMatchItsOperation(t *testing.T) {
	server := &nativeServer{}
	for _, test := range []struct{ command, operation string }{
		{"bifoil.choicescript.server.unknown", "run"},
		{"bifoil.choicescript.server.run.extra", "run"},
		{"bifoil.choicescript.server.quicktest", "exportHtml"},
	} {
		params, _ := json.Marshal(map[string]any{"command": test.command, "arguments": []any{map[string]any{"protocolVersion": 1, "operation": test.operation, "trusted": true}}})
		_, err := server.request(context.Background(), rpcMessage{Method: "workspace/executeCommand", Params: params})
		var failure *rpcError
		if !errors.As(err, &failure) || failure.Code != -32602 {
			t.Fatalf("%s: %v", test.command, err)
		}
	}
}

func TestStoppedToolWritesRetainTheOriginalFailure(t *testing.T) {
	original := errors.New("Original broker pipe failure")
	for _, failure := range []error{nil, original} {
		process := &toolProcess{done: make(chan struct{}), failure: failure}
		close(process.done)
		err := process.write(t.Context(), map[string]string{"method": "stale"})
		if failure != nil && !errors.Is(err, original) || failure == nil && (err == nil || err.Error() != "Game tooling stopped.") {
			t.Fatalf("stopped write lost its failure: %v", err)
		}
	}
}
