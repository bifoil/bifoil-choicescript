package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

type nativeTestClient struct {
	stream        *rpcStream
	mu            sync.Mutex
	next          int
	waiting       map[string]chan rpcMessage
	notifications chan rpcMessage
	closed        chan struct{}
}

func newNativeTestClient(t *testing.T) *nativeTestClient {
	t.Helper()
	server, client := net.Pipe()
	c := &nativeTestClient{stream: newRPC(client, client), waiting: make(map[string]chan rpcMessage), notifications: make(chan rpcMessage, 4096), closed: make(chan struct{})}
	result := make(chan error, 1)
	go func() { result <- serveNative(server, server); _ = server.Close() }()
	go func() {
		defer close(c.closed)
		for {
			m, err := c.stream.read()
			if err != nil {
				return
			}
			if m.Method != "" {
				c.notifications <- m
				continue
			}
			c.mu.Lock()
			response := c.waiting[string(m.ID)]
			delete(c.waiting, string(m.ID))
			c.mu.Unlock()
			if response != nil {
				response <- m
			}
		}
	}()
	t.Cleanup(func() {
		_ = client.Close()
		select {
		case err := <-result:
			if err != nil && !strings.Contains(err.Error(), "closed") {
				t.Errorf("server shutdown: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("server did not clean up after transport closed")
		}
	})
	return c
}
func (c *nativeTestClient) notify(t *testing.T, method string, params any) {
	t.Helper()
	if err := c.stream.notify(method, params); err != nil {
		t.Fatal(err)
	}
}
func (c *nativeTestClient) request(t *testing.T, method string, params any) json.RawMessage {
	t.Helper()
	c.mu.Lock()
	c.next++
	id := fmt.Sprint(c.next)
	response := make(chan rpcMessage, 1)
	c.waiting[id] = response
	c.mu.Unlock()
	if err := c.stream.send(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id), "method": method, "params": params}); err != nil {
		t.Fatal(err)
	}
	select {
	case m := <-response:
		if m.Error != nil {
			t.Fatalf("%s: %v", method, m.Error)
		}
		return m.Result
	case <-time.After(10 * time.Second):
		t.Fatalf("%s did not complete", method)
	}
	return nil
}
func TestNativeLSPDialogueAndVersionCorrectUnsavedChanges(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "startup.txt")
	text := "*create gender \"male\"\n*create implicit_control_flow true\nShe said \"This is the end,\n*if gender = \"male\"\n    William.\"\n*else\n    Belle.\"\nShe walked away."
	if err := os.WriteFile(file, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	c := newNativeTestClient(t)
	c.request(t, "initialize", map[string]any{"workspaceFolders": []any{map[string]string{"uri": pathURI(dir), "name": "Original"}}})
	c.notify(t, "initialized", map[string]any{})
	uri := pathURI(file)
	c.notify(t, "textDocument/didOpen", map[string]any{"textDocument": map[string]any{"uri": uri, "languageId": "choicescript", "version": 1, "text": text}})
	tokens := c.request(t, "textDocument/semanticTokens/full", map[string]any{"textDocument": map[string]string{"uri": uri}})
	var data struct{ Data []uint32 }
	if err := json.Unmarshal(tokens, &data); err != nil {
		t.Fatal(err)
	}
	var line, column uint32
	branches := map[uint32]bool{}
	for i := 0; i < len(data.Data); i += 5 {
		delta := data.Data[i]
		line += delta
		if delta != 0 {
			column = 0
		}
		column += data.Data[i+1]
		kind := uint8(data.Data[i+3])
		if (line == 4 || line == 6) && kind == core.Dialogue {
			branches[line] = true
		}
		if line == 7 && kind != core.Narrative {
			t.Fatal("dialogue leaked past the unanimous branch close")
		}
		if line == 3 && kind == core.Dialogue {
			t.Fatal("expression was treated as narrative dialogue")
		}
	}
	if !branches[4] || !branches[6] {
		t.Fatal("a branch did not inherit dialogue state")
	}
	changed := strings.Replace(text, "*create gender \"male\"", "*create gender 42", 1)
	c.notify(t, "textDocument/didChange", map[string]any{"textDocument": map[string]any{"uri": uri, "version": 2}, "contentChanges": []map[string]any{{"text": changed}}})
	hover := c.request(t, "textDocument/hover", map[string]any{"textDocument": map[string]string{"uri": uri}, "position": core.Position{Line: 3, Character: 5}})
	if !strings.Contains(string(hover), "number") {
		t.Fatal("hover returned stale types after an unsaved command edit", string(hover))
	}
	status := c.request(t, "choicescript/indexStatus", nil)
	var indexes []struct {
		Complete, Limited bool
		Scenes            int
	}
	if err := json.Unmarshal(status, &indexes); err != nil || len(indexes) != 1 || !indexes[0].Complete || indexes[0].Limited || indexes[0].Scenes != 1 {
		t.Fatal("server did not expose complete full-project analysis", string(status), err)
	}
	c.request(t, "shutdown", nil)
	c.notify(t, "exit", nil)
}
func TestNativeLSPLosslessPagingBetweenGames(t *testing.T) {
	dir := t.TempDir()
	uris := []string{}
	for i := range 2 {
		root := filepath.Join(dir, fmt.Sprint(i))
		if err := os.Mkdir(root, 0700); err != nil {
			t.Fatal(err)
		}
		file := filepath.Join(root, "startup.txt")
		if err := os.WriteFile(file, []byte("*create score 1\n*print score\n*ending"), 0600); err != nil {
			t.Fatal(err)
		}
		uris = append(uris, pathURI(file))
	}
	c := newNativeTestClient(t)
	c.request(t, "initialize", map[string]any{"workspaceFolders": []any{map[string]string{"uri": pathURI(dir)}}})
	c.notify(t, "initialized", nil)
	for _, uri := range []string{uris[0], uris[1], uris[0]} {
		hover := c.request(t, "textDocument/hover", map[string]any{"textDocument": map[string]string{"uri": uri}, "position": core.Position{Line: 1, Character: 8}})
		if !strings.Contains(string(hover), "number") {
			t.Fatal("paging lost the full type result", string(hover))
		}
	}
	c.request(t, "shutdown", nil)
	c.notify(t, "exit", nil)
}
func TestNativeTextSynchronizationUsesUTF16AndCRLF(t *testing.T) {
	original := openBuffer{Text: "😀 one\r\ntwo", Version: 1}
	r := core.Range{Start: core.Position{Line: 0, Character: 3}, End: core.Position{Line: 1, Character: 1}}
	result, err := changeBuffer(original, 2, []textChange{{Range: &r, Text: "new "}})
	if err != nil || result.Text != "😀 new wo" {
		t.Fatal("UTF-16 multiline edit changed source", result, err)
	}
	split := core.Range{Start: core.Position{Line: 0, Character: 1}, End: core.Position{Line: 0, Character: 2}}
	if _, err = changeBuffer(original, 2, []textChange{{Range: &split, Text: ""}}); err == nil {
		t.Fatal("accepted an edit splitting a surrogate pair")
	}
	if _, err = changeBuffer(original, 1, nil); err == nil {
		t.Fatal("accepted an obsolete editor version")
	}
}

func TestNativeLSPIncludesAndRemovesUnsavedNewScenes(t *testing.T) {
	directory := t.TempDir()
	startup := filepath.Join(directory, "startup.txt")
	source := "*create name \"William\"\n*scene_list\n  startup\n  draft\nShe said \"Hello,\n*finish\n"
	if err := os.WriteFile(startup, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	draftURI := pathURI(filepath.Join(directory, "draft.txt"))
	client := newNativeTestClient(t)
	client.request(t, "initialize", map[string]any{"workspaceFolders": []any{map[string]string{"uri": pathURI(directory)}}})
	client.notify(t, "initialized", map[string]any{})
	client.notify(t, "textDocument/didOpen", map[string]any{"textDocument": map[string]any{"uri": draftURI, "languageId": "choicescript", "version": 1, "text": "Welcome ${name}.\"\n*ending"}})
	params := map[string]any{"textDocument": map[string]string{"uri": draftURI}, "position": core.Position{Line: 0, Character: 11}}
	hover := client.request(t, "textDocument/hover", params)
	if !strings.Contains(string(hover), "string") {
		t.Fatalf("new scene did not receive full project types: %s", hover)
	}
	definition := client.request(t, "textDocument/definition", params)
	if !strings.Contains(string(definition), pathURI(startup)) {
		t.Fatal("new scene did not resolve startup symbol")
	}
	var semantic struct{ Data []uint32 }
	if err := json.Unmarshal(client.request(t, "textDocument/semanticTokens/full", map[string]any{"textDocument": map[string]string{"uri": draftURI}}), &semantic); err != nil {
		t.Fatal(err)
	}
	if len(semantic.Data) < 5 || semantic.Data[3] != uint32(core.Dialogue) {
		t.Fatal("new scene lost inherited dialogue")
	}
	var status []struct {
		Scenes            int
		Complete, Limited bool
	}
	if err := json.Unmarshal(client.request(t, "choicescript/indexStatus", nil), &status); err != nil {
		t.Fatal(err)
	}
	if len(status) != 1 || status[0].Scenes != 2 || !status[0].Complete || status[0].Limited {
		t.Fatal("new scene omitted from complete status", status)
	}
	client.notify(t, "textDocument/didClose", map[string]any{"textDocument": map[string]string{"uri": draftURI}})
	client.request(t, "choicescript/wordCount", map[string]string{"uri": pathURI(startup)})
	if err := json.Unmarshal(client.request(t, "choicescript/indexStatus", nil), &status); err != nil {
		t.Fatal(err)
	}
	if len(status) != 1 || status[0].Scenes != 1 || !status[0].Complete {
		t.Fatal("closed unsaved scene remained indexed", status)
	}
}
