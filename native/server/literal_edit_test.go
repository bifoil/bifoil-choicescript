package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUnusedDeclarationEditPublishesFreshCompleteLanguageResults(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "startup.txt")
	text := "*create spare 1\nOriginal narrative.\n*ending"
	if err := os.WriteFile(file, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	c := newNativeTestClient(t)
	uri := pathURI(file)
	c.request(t, "initialize", map[string]any{"workspaceFolders": []any{map[string]string{"uri": pathURI(dir), "name": "Original"}}})
	c.notify(t, "initialized", map[string]any{})
	c.notify(t, "textDocument/didOpen", map[string]any{"textDocument": map[string]any{"uri": uri, "languageId": "choicescript", "version": 1, "text": text}})
	params := map[string]any{"textDocument": map[string]string{"uri": uri}, "position": map[string]int{"line": 0, "character": 9}}
	if !strings.Contains(string(c.request(t, "textDocument/hover", params)), "number") {
		t.Fatal("initial declaration type missing")
	}
	c.notify(t, "textDocument/didChange", map[string]any{"textDocument": map[string]any{"uri": uri, "version": 2}, "contentChanges": []any{map[string]any{"range": map[string]any{"start": map[string]int{"line": 0, "character": 14}, "end": map[string]int{"line": 0, "character": 15}}, "text": "\"changed Ω😀\""}}})
	if !strings.Contains(string(c.request(t, "textDocument/hover", params)), "string") {
		t.Fatal("declaration edit returned stale type")
	}
	var status []struct {
		Complete, Limited bool
		Scenes            int
		Failure           string
	}
	if err := json.Unmarshal(c.request(t, "choicescript/indexStatus", nil), &status); err != nil {
		t.Fatal(err)
	}
	if len(status) != 1 || !status[0].Complete || status[0].Limited || status[0].Scenes != 1 || status[0].Failure != "" {
		t.Fatal("declaration edit lost complete project state")
	}
	if string(c.request(t, "textDocument/definition", params)) == "null" {
		t.Fatal("declaration definition missing after edit")
	}
}
