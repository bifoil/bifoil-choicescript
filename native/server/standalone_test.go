package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

func TestExplicitUnsavedStandaloneFileIsCompleteWithoutClaimingNeighbors(t *testing.T) {
	root := t.TempDir()
	selected := filepath.Join(root, "selected.txt")
	neighbor := filepath.Join(root, "unrelated.txt")
	if err := os.WriteFile(neighbor, []byte("*create unrelated false\n*ending"), 0600); err != nil {
		t.Fatal(err)
	}
	client := newNativeTestClient(t)
	client.request(t, "initialize", map[string]any{"workspaceFolders": []any{map[string]string{"uri": pathURI(root)}}})
	client.notify(t, "initialized", map[string]any{})
	client.notify(t, "textDocument/didOpen", map[string]any{"textDocument": map[string]any{"uri": pathURI(neighbor), "languageId": "plaintext", "version": 1, "text": "Ordinary notes."}})
	if got := client.request(t, "choicescript/indexStatus", nil); string(got) != "[]" {
		t.Fatalf("plain text was claimed: %s", got)
	}
	uri := pathURI(selected)
	source := "*create score 1\n*print score\n*ending"
	client.notify(t, "textDocument/didOpen", map[string]any{"textDocument": map[string]any{"uri": uri, "languageId": "choicescript", "version": 1, "text": source}})
	params := map[string]any{"textDocument": map[string]string{"uri": uri}, "position": core.Position{Line: 1, Character: 8}}
	if hover := client.request(t, "textDocument/hover", params); !strings.Contains(string(hover), "number") {
		t.Fatalf("missing complete standalone analysis: %s", hover)
	}
	var status []struct {
		Complete, Limited bool
		Scenes            int
	}
	if err := json.Unmarshal(client.request(t, "choicescript/indexStatus", nil), &status); err != nil || len(status) != 1 || !status[0].Complete || status[0].Limited || status[0].Scenes != 1 {
		t.Fatalf("incomplete or guessed neighboring sources: %v %v", status, err)
	}
	if got := client.request(t, "choicescript/projects", nil); string(got) != "[]" {
		t.Fatal("standalone file was presented as a detected game", string(got))
	}
	if got := client.request(t, "textDocument/hover", map[string]any{"textDocument": map[string]string{"uri": pathURI(neighbor)}, "position": core.Position{Line: 0, Character: 8}}); string(got) != "null" {
		t.Fatal("unrelated text acquired language results", string(got))
	}
	client.notify(t, "textDocument/didChange", map[string]any{"textDocument": map[string]any{"uri": uri, "version": 2}, "contentChanges": []any{map[string]any{"text": strings.Replace(source, "score 1", "score true", 1)}}})
	if hover := client.request(t, "textDocument/hover", params); !strings.Contains(string(hover), "boolean") {
		t.Fatal("stale standalone edit", string(hover))
	}
	client.notify(t, "textDocument/didClose", map[string]any{"textDocument": map[string]string{"uri": uri}})
	if got := client.request(t, "choicescript/indexStatus", nil); string(got) != "[]" {
		t.Fatal("closed standalone analysis retained", string(got))
	}
	if _, err := os.Stat(selected); !os.IsNotExist(err) {
		t.Fatal("unsaved source was written to disk")
	}
}
