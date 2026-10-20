package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReopeningVersionZeroDoesNotAdoptUnsavedSnapshotAsDisk(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "startup.txt")
	disk := "*create score 1\n*print score\n*ending"
	if err := os.WriteFile(file, []byte(disk), 0600); err != nil {
		t.Fatal(err)
	}
	client := newNativeTestClient(t)
	uri := pathURI(file)
	client.request(t, "initialize", map[string]any{"workspaceFolders": []any{map[string]string{"uri": pathURI(root), "name": "Original"}}})
	client.notify(t, "initialized", map[string]any{})
	params := map[string]any{"textDocument": map[string]string{"uri": uri}, "position": map[string]int{"line": 1, "character": 8}}
	for _, test := range []struct{ text, kind string }{
		{strings.Replace(disk, "score 1", `score "original unsaved"`, 1), "string"},
		{disk, "number"},
		{strings.Replace(disk, "score 1", "score true", 1), "boolean"},
		{disk, "number"},
	} {
		client.notify(t, "textDocument/didOpen", map[string]any{"textDocument": map[string]any{"uri": uri, "languageId": "choicescript", "version": 0, "text": test.text}})
		if !strings.Contains(string(client.request(t, "textDocument/hover", params)), test.kind) {
			t.Fatalf("reopen returned stale %s", test.kind)
		}
	}
}
func TestBufferOriginUsesPhysicalIdentityWithoutConflatingDifferentFiles(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "startup.txt")
	alias := filepath.Join(root, "STARTUP.txt")
	if err := os.WriteFile(file, []byte("Original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(file, alias); err != nil {
		t.Skip(err)
	}
	origins := map[string]int32{pathURI(file): 0}
	if !hasBufferOrigin(origins, pathURI(alias)) {
		t.Fatal("physical alias escaped origin check")
	}
	other := filepath.Join(t.TempDir(), "startup.txt")
	if err := os.WriteFile(other, []byte("Original"), 0600); err != nil {
		t.Fatal(err)
	}
	if hasBufferOrigin(origins, pathURI(other)) {
		t.Fatal("distinct file conflated with open source")
	}
}
