package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestRemovedProjectRetiresIndexesAndAdvancesReaddedGeneration(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "startup.txt")
	if err := os.WriteFile(file, []byte("*ending"), 0600); err != nil {
		t.Fatal(err)
	}
	s := &nativeServer{ctx: context.Background(), stream: newRPC(nil, io.Discard), roots: []string{pathURI(root)}, revisions: map[string]uint64{}, indexes: map[string]nativeIndex{}, changed: make(chan struct{}), wake: make(chan struct{}, 1), toolStarts: map[string]toolPending{}}
	s.refreshProjects()
	if len(s.projects) != 1 {
		t.Fatal("project missing")
	}
	id := s.projects[0].ID
	oldRevision := s.revisions[id]
	cache := filepath.Join(t.TempDir(), "owned-snapshot.bin")
	if err := os.WriteFile(cache, []byte("owned"), 0600); err != nil {
		t.Fatal(err)
	}
	s.indexes[id] = nativeIndex{complete: true, revision: oldRevision, cacheFile: cache}
	s.currentID = id
	s.preferred = id
	cancelled := false
	s.activeID = id
	s.activeCancel = func() { cancelled = true }
	pendingCancelled := false
	s.toolStarts["pending"] = toolPending{ProjectID: id, Cancel: func() { pendingCancelled = true }}
	s.roots = nil
	s.refreshProjects()
	if len(s.indexes) != 0 || len(s.revisions) != 0 || s.currentID != "" || s.preferred != "" || !cancelled || !pendingCancelled {
		t.Fatal("removed project retained live state")
	}
	if _, err := os.Stat(cache); !os.IsNotExist(err) {
		t.Fatal("owned query file was retained")
	}
	s.roots = []string{pathURI(root)}
	s.refreshProjects()
	if s.revisions[id] <= oldRevision {
		t.Fatal("late analysis can collide with a readded generation")
	}
}
