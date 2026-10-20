package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReusedDiskAnalysisPublishesTheOpenedDocumentVersion(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "startup.txt")
	text := "*create score 1\n*set score \"unterminated\n*ending"
	if err := os.WriteFile(file, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	c := newNativeTestClient(t)
	uri := pathURI(file)
	c.request(t, "initialize", map[string]any{"workspaceFolders": []any{map[string]string{"uri": pathURI(root)}}})
	c.notify(t, "initialized", map[string]any{})
	c.request(t, "choicescript/wordCount", map[string]string{"uri": uri})
	c.notify(t, "textDocument/didOpen", map[string]any{"textDocument": map[string]any{"uri": uri, "version": 7, "languageId": "choicescript", "text": text}})
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case message := <-c.notifications:
			if message.Method != "textDocument/publishDiagnostics" {
				continue
			}
			var p struct {
				URI         string
				Version     *int32
				Diagnostics []json.RawMessage
			}
			if err := json.Unmarshal(message.Params, &p); err != nil {
				t.Fatal(err)
			}
			if p.URI == uri && p.Version != nil && *p.Version == 7 {
				if len(p.Diagnostics) == 0 {
					t.Fatal("existing source errors lost on open")
				}
				return
			}
		case <-deadline.C:
			t.Fatal("byte-identical disk reuse never republished current diagnostics")
		}
	}
}
