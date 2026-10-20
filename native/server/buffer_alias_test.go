package main

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

func TestNewestAliasWinsAcrossInlineAndCapturedBuffers(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "startup.txt")
	disk := "*create score 1\n*print score\n*ending"
	if err := os.WriteFile(file, []byte(disk), 0600); err != nil {
		t.Fatal(err)
	}
	uri := pathURI(file)
	parsed, _ := url.Parse(uri)
	parsed.Host = "localhost"
	alias := parsed.String()
	buffers := map[string]openBuffer{
		uri:   {URI: uri, Version: 100, Order: 1, Store: newTextStore([]textPiece{{text: disk, size: int64(len(disk))}})},
		alias: {URI: alias, Version: 1, Order: 2, Text: strings.Replace(disk, "score 1", "score true", 1)},
	}
	for range 30 {
		p := core.NewProject()
		_, files, _, err := loadDirectoryBuffers(context.Background(), root, p, buffers)
		if err != nil || files != 1 {
			t.Fatalf("load %v files %d", err, files)
		}
		if err = p.Analyze(context.Background()); err != nil {
			t.Fatal(err)
		}
		hover, _ := json.Marshal(p.Hover(0, core.Position{Line: 1, Character: 8}))
		if p.Documents[0].URI != alias || !strings.Contains(string(hover), "boolean") {
			t.Fatal("alias selection depended on map order or URI-local version")
		}
	}
}

func TestAliasEditsAndCloseReturnCurrentTypes(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "startup.txt")
	disk := "*create score 1\n*print score\n*ending"
	if err := os.WriteFile(file, []byte(disk), 0600); err != nil {
		t.Fatal(err)
	}
	uri := pathURI(file)
	parsed, _ := url.Parse(uri)
	parsed.Host = "localhost"
	alias := parsed.String()
	client := newNativeTestClient(t)
	client.request(t, "initialize", map[string]any{"workspaceFolders": []any{map[string]string{"uri": pathURI(root)}}})
	client.notify(t, "initialized", map[string]any{})
	open := func(uri, text string, version int) {
		client.notify(t, "textDocument/didOpen", map[string]any{"textDocument": map[string]any{"uri": uri, "languageId": "choicescript", "version": version, "text": text}})
	}
	hover := func(uri, kind string) {
		got := client.request(t, "textDocument/hover", map[string]any{"textDocument": map[string]string{"uri": uri}, "position": core.Position{Line: 1, Character: 8}})
		if !strings.Contains(string(got), kind) {
			t.Fatalf("expected %s: %s", kind, got)
		}
	}
	open(uri, disk, 100)
	hover(uri, "number")
	open(alias, strings.Replace(disk, "score 1", "score true", 1), 1)
	hover(uri, "boolean")
	hover(alias, "boolean")
	client.notify(t, "textDocument/didChange", map[string]any{"textDocument": map[string]any{"uri": uri, "version": 101}, "contentChanges": []any{map[string]any{"text": strings.Replace(disk, "score 1", `score "changed"`, 1)}}})
	hover(alias, "string")
	client.notify(t, "textDocument/didClose", map[string]any{"textDocument": map[string]string{"uri": uri}})
	hover(alias, "boolean")
}
