package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestShutdownCancelsOwnedWorkAndClosesToolAdmission(t *testing.T) {
	active, request, pending := false, false, false
	server := &nativeServer{ctx: context.Background(), changed: make(chan struct{}), wake: make(chan struct{}, 1), activeCancel: func() { active = true }, requests: map[string]*nativeRequest{"original": {cancel: func() { request = true }}}, toolStarts: map[string]toolPending{"original": {Cancel: func() { pending = true }}}}
	server.tools = &toolBridge{server: server}
	if _, err := server.request(context.Background(), rpcMessage{Method: "shutdown"}); err != nil {
		t.Fatal(err)
	}
	if !active || !request || !pending {
		t.Fatal("shutdown left owned work active")
	}
	if _, err := server.tools.start(); err == nil {
		t.Fatal("shutdown allowed a new owned process")
	}
}

func TestShutdownRemovesCapturedSourcesBeforeAcknowledgement(t *testing.T) {
	temporary := t.TempDir()
	for _, variable := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(variable, temporary)
	}
	game := t.TempDir()
	report := filepath.Join(game, "shutdown-resources.json")
	t.Setenv("BIFOIL_NATIVE_RESOURCE_REPORT", report)
	file := filepath.Join(game, "startup.txt")
	text := "*create score 1\n" + strings.Repeat("Original captured source.\n", 60000) + "*ending\n"
	if err := os.WriteFile(file, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	client := newNativeTestClient(t)
	client.request(t, "initialize", map[string]any{"workspaceFolders": []any{map[string]string{"uri": pathURI(game)}}})
	client.notify(t, "initialized", nil)
	client.notify(t, "textDocument/didOpen", map[string]any{"textDocument": map[string]any{"uri": pathURI(file), "languageId": "choicescript", "version": 1, "text": text}})
	client.request(t, "textDocument/semanticTokens/full", map[string]any{"textDocument": map[string]string{"uri": pathURI(file)}})
	before, err := filepath.Glob(filepath.Join(temporary, "bifoil-language-*"))
	if err != nil || len(before) != 1 {
		t.Fatalf("expected one captured-source owner before shutdown: %v %v", before, err)
	}
	client.request(t, "shutdown", nil)
	if _, err := os.Stat(before[0]); !os.IsNotExist(err) {
		t.Fatalf("shutdown acknowledged before captured source cleanup: %v", err)
	}
	if _, err := os.Stat(report); err != nil {
		t.Fatalf("shutdown acknowledged before saving resource evidence: %v", err)
	}
	// Deliberately omit exit: the test closes the transport just as an editor may
	// terminate the process immediately after acknowledging shutdown.
}
