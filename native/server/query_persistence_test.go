package main

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

func TestEvictionPersistsEveryResultAndWaitsForResponseReaders(t *testing.T) {
	p := core.NewProject()
	p.AddSource(core.Source{URI: "file:///original/startup.txt", Text: "*create name \"William\"\nShe said \"Hello,\n${name}.\"\n*ending"})
	if err := p.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	p.CompactForQueries()
	server := &nativeServer{ctx: context.Background(), cacheDir: t.TempDir(), current: p, currentID: "original", indexes: map[string]nativeIndex{"original": {complete: true}}, revisions: map[string]uint64{"original": 0}}
	scope := &queryScope{}
	ctx := context.WithValue(context.Background(), queryScopeKey{}, scope)
	server.mu.Lock()
	server.retainQueryLocked(ctx)
	server.mu.Unlock()
	completed := make(chan error, 1)
	go func() { completed <- server.evictCurrent() }()
	deadline := time.Now().Add(time.Second)
	var filename string
	for time.Now().Before(deadline) {
		server.mu.Lock()
		filename = server.indexes["original"].cacheFile
		cleared := server.current == nil
		server.mu.Unlock()
		if filename != "" && cleared {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if filename == "" {
		scope.close()
		t.Fatal("complete index was not persisted")
	}
	select {
	case <-completed:
		scope.close()
		t.Fatal("eviction overlapped an active response")
	default:
	}
	scope.close()
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("eviction did not finish after response released")
	}
	file, err := os.Open(filename)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	restored, err := core.ReadSnapshot(file)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(p.Tokens, restored.Tokens) || !reflect.DeepEqual(p.Symbols, restored.Symbols) || !reflect.DeepEqual(p.Documents, restored.Documents) {
		t.Fatal("eviction changed complete query results")
	}
}
func TestPagingFailurePreservesCurrentEditingIndex(t *testing.T) {
	p := core.NewProject()
	p.AddSource(core.Source{URI: "file:///original/startup.txt", Text: "Original prose."})
	if err := p.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	p.CompactForQueries()
	server := &nativeServer{ctx: context.Background(), cacheDir: filepath.Join(t.TempDir(), "missing"), current: p, currentID: "original", indexes: map[string]nativeIndex{"original": {complete: true}}, revisions: map[string]uint64{"original": 0}}
	if err := server.evictCurrent(); err == nil {
		t.Fatal("paging failure was hidden")
	}
	if server.current != p || !server.indexes["original"].complete {
		t.Fatal("cache failure discarded current editing assistance")
	}
}
