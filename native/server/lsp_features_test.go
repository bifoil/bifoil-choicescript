package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

func TestNativeLanguageRequestsUseTheSameCurrentSymbol(t *testing.T) {
	root := t.TempDir()
	text := "*create score 7\n*label entry\n*if score > 0\n    *print score\n*goto entry\nOriginal narrative words.\n*ending"
	file := filepath.Join(root, "startup.txt")
	if err := os.WriteFile(file, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	uri := pathURI(file)
	client := newNativeTestClient(t)
	client.request(t, "initialize", map[string]any{"rootUri": pathURI(root), "initializationOptions": map[string]bool{"quoteWarnings": false}})
	client.notify(t, "initialized", nil)
	client.notify(t, "textDocument/didOpen", map[string]any{"textDocument": map[string]any{"uri": uri, "languageId": "choicescript", "version": 1, "text": text}})
	params := map[string]any{"textDocument": map[string]string{"uri": uri}, "position": core.Position{Line: 3, Character: 12}}
	if got := string(client.request(t, "textDocument/hover", params)); !strings.Contains(got, "score") || !strings.Contains(got, "number") {
		t.Fatal(got)
	}
	if got := string(client.request(t, "textDocument/definition", params)); !strings.Contains(got, uri) || !strings.Contains(got, `"line":0`) {
		t.Fatal(got)
	}
	params["context"] = map[string]bool{"includeDeclaration": false}
	var refs []core.Location
	if err := json.Unmarshal(client.request(t, "textDocument/references", params), &refs); err != nil || len(refs) != 2 {
		t.Fatal("reference set changed", refs, err)
	}
	for _, ref := range refs {
		if ref.Range.Start.Line == 0 {
			t.Fatal("excluded declaration was returned")
		}
	}
	if got := string(client.request(t, "textDocument/prepareRename", params)); !strings.Contains(got, `"line":3`) {
		t.Fatal(got)
	}
	params["newName"] = "renamed_score"
	if got := string(client.request(t, "textDocument/rename", params)); strings.Count(got, "renamed_score") != 3 {
		t.Fatal(got)
	}
	if got := string(client.request(t, "textDocument/documentSymbol", params)); !strings.Contains(got, "score") || !strings.Contains(got, "entry") {
		t.Fatal(got)
	}
	if got := string(client.request(t, "textDocument/foldingRange", params)); !strings.Contains(got, `"startLine":2`) {
		t.Fatal(got)
	}
	params["positions"] = []core.Position{{Line: 3, Character: 12}, {Line: 5, Character: 5}}
	var selections []json.RawMessage
	if err := json.Unmarshal(client.request(t, "textDocument/selectionRange", params), &selections); err != nil || len(selections) != 2 {
		t.Fatal(selections, err)
	}
	if got := string(client.request(t, "choicescript/wordCount", map[string]string{"uri": uri})); got != "3" {
		t.Fatal("narrative count", got)
	}
	params["position"] = core.Position{Line: 3, Character: 5}
	if got := string(client.request(t, "textDocument/completion", params)); !strings.Contains(got, "print") {
		t.Fatal("command completion", got)
	}
	if got := string(client.request(t, "workspace/symbol", map[string]string{"query": "SCORE"})); !strings.Contains(got, "score") {
		t.Fatal(got)
	}
	client.request(t, "shutdown", nil)
	client.notify(t, "exit", nil)
}

func TestMalformedProtocolRequestsHaveSpecificErrors(t *testing.T) {
	server := &nativeServer{}
	for _, test := range []struct {
		method, params string
		code           int
	}{
		{"initialize", "{", -32602},
		{"textDocument/hover", "{", -32602},
		{"unknown/method", "{}", -32601},
		{"choicescript/job", "{", -32602},
		{"workspace/executeCommand", `{"command":"bifoil.choicescript.server.run","arguments":[]}`, -32602},
		{"choicescript/job", `{"protocolVersion":1,"operation":"run","trusted":false}`, -32600},
	} {
		_, err := server.request(context.Background(), rpcMessage{Method: test.method, Params: []byte(test.params)})
		var failure *rpcError
		if !errors.As(err, &failure) || failure.Code != test.code {
			t.Fatalf("%s %s: %v", test.method, test.params, err)
		}
	}
}

func TestAnalyzeDirectoryReportsCompleteOriginalSource(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "startup.txt"), []byte("*create n 1\n*print n\nOriginal three words.\n*ending"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BIFOIL_NATIVE_TRACE", "1")
	t.Setenv("BIFOIL_NATIVE_ANALYSIS_TIMEOUT", "5s")
	original := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = writer
	t.Cleanup(func() { os.Stdout = original; _ = reader.Close(); _ = writer.Close() })
	if err = analyzeDirectory(root); err != nil {
		t.Fatal(err)
	}
	_ = writer.Close()
	os.Stdout = original
	raw, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	var report struct{ Files, Words, Tokens, InvalidTokens int }
	if err = json.Unmarshal(raw, &report); err != nil || report.Files != 1 || report.Words != 3 || report.Tokens == 0 || report.InvalidTokens != 0 {
		t.Fatal(string(raw), err)
	}
	t.Setenv("BIFOIL_NATIVE_ANALYSIS_TIMEOUT", "invalid")
	if err = analyzeDirectory(root); err == nil {
		t.Fatal("invalid timeout accepted")
	}
	t.Setenv("BIFOIL_NATIVE_CPU_PROFILE", filepath.Join(root, "missing/profile"))
	if err = analyzeDirectory(root); err == nil {
		t.Fatal("unwritable profile accepted")
	}
}

func TestNativeWorkspaceReplacementAndWarningConfiguration(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"old", "new"} {
		directory := filepath.Join(root, name)
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "startup.txt"), []byte("*create score 1\nOriginal source.\n*ending"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	client := newNativeTestClient(t)
	folder := func(name string) map[string]string {
		return map[string]string{"uri": pathURI(filepath.Join(root, name)), "name": name}
	}
	client.request(t, "initialize", map[string]any{"workspaceFolders": []any{folder("old")}})
	client.notify(t, "initialized", nil)
	client.notify(t, "workspace/didChangeWorkspaceFolders", map[string]any{"event": map[string]any{"removed": []any{folder("old")}, "added": []any{folder("new")}}})
	projects := string(client.request(t, "choicescript/projects", nil))
	if strings.Contains(projects, filepath.ToSlash(filepath.Join(root, "old"))) || !strings.Contains(projects, "new") {
		t.Fatal("workspace replacement retained an obsolete game", projects)
	}
	uri := pathURI(filepath.Join(root, "new", "startup.txt"))
	for _, settings := range []any{map[string]any{"bifoil.choicescript": map[string]bool{"quoteWarnings": false}}, map[string]any{"bifoil": map[string]any{"choicescript": map[string]bool{"quoteWarnings": true}}}} {
		client.notify(t, "workspace/didChangeConfiguration", map[string]any{"settings": settings})
		if got := string(client.request(t, "textDocument/hover", map[string]any{"textDocument": map[string]string{"uri": uri}, "position": core.Position{Line: 0, Character: 9}})); !strings.Contains(got, "number") {
			t.Fatal("configuration update lost analysis", got)
		}
	}
	client.notify(t, "workspace/didChangeWatchedFiles", map[string]any{"changes": []any{map[string]any{"uri": uri, "type": 2}, map[string]string{"uri": pathURI(filepath.Join(root, "new", "choicescript.json"))}, map[string]string{"uri": "invalid URI"}}})
	if got := string(client.request(t, "choicescript/wordCount", map[string]string{"uri": uri})); got != "2" {
		t.Fatal("watcher changed source word count", got)
	}
	client.request(t, "shutdown", nil)
	client.notify(t, "exit", nil)
}

func TestMalformedNotificationsCannotMutateExistingState(t *testing.T) {
	server := &nativeServer{quoteWarnings: true}
	for _, method := range []string{"$/cancelRequest", "textDocument/didOpen", "textDocument/didChange", "textDocument/didClose", "workspace/didChangeConfiguration", "workspace/didChangeWorkspaceFolders", "workspace/didChangeWatchedFiles", "choicescript/assetChanged"} {
		server.notification(rpcMessage{Method: method, Params: []byte("{")})
		if !server.quoteWarnings || len(server.buffers) != 0 || len(server.roots) != 0 {
			t.Fatal("malformed notification mutated state", method)
		}
	}
}
