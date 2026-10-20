package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A real child implements the public broker transport. Its responses expose the
// captured bytes, allowing tests to verify snapshot ownership independently of
// the official tool's parser and without depending on generated bundles.
func testToolBridge(t *testing.T) (*nativeServer, *toolBridge) {
	t.Helper()
	node := os.Getenv("BIFOIL_TEST_NODE")
	if node == "" {
		var err error
		node, err = exec.LookPath("node")
		if err != nil {
			t.Skip("Node is required for broker process integration")
		}
	}
	bundle := t.TempDir()
	program := `const readline = require('node:readline');
const fs = require('node:fs');
const stale = [];
const input = readline.createInterface({input: process.stdin});
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'stale') { stale.push(message.params.projectId); return; }
  if (message.method === 'dispose') { send({id: message.id, result: null}); input.close(); return; }
  if (message.method === 'error') { send({id: message.id, error: {code: -32602, message: 'Original fixture rejection'}}); return; }
  if (message.method === 'wait') return;
  if (message.method === 'crash') { process.exit(3); return; }
  if (message.method === 'status') { send({id: message.id, result: stale}); return; }
  if (message.method === 'log') { console.error('Original broker log'); send({method: 'choicescript/jobEvent', params: {kind: 'output'}}); }
  const params = message.params || {};
  const captured = (params.buffers || []).map(buffer => ({...buffer, text: fs.readFileSync(buffer.textFile, 'utf8')}));
  send({id: message.id, result: {request: params.request, captured}});
});`
	if err := os.WriteFile(filepath.Join(bundle, "tool-broker.cjs"), []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	s := &nativeServer{
		ctx: context.Background(), cacheDir: t.TempDir(), stream: newRPC(bytes.NewReader(nil), io.Discard),
		buffers: make(map[string]openBuffer), toolStarts: make(map[string]toolPending),
		revisions: make(map[string]uint64), indexes: make(map[string]nativeIndex),
		changed: make(chan struct{}), wake: make(chan struct{}, 1),
	}
	b := &toolBridge{server: s, options: nativeOptions{Node: node, Bundle: bundle}}
	s.tools = b
	t.Cleanup(b.close)
	return s, b
}

func TestToolBridgeOwnsSnapshotsAndRetainsBrokerErrors(t *testing.T) {
	s, bridge := testToolBridge(t)
	root := t.TempDir()
	s.projects = []gameProject{{ID: "original", Root: root, SceneDir: root, AssetDir: root}}
	uri := pathURI(filepath.Join(root, "startup.txt"))
	s.buffers[uri] = openBuffer{URI: uri, Version: 7, Text: "Unsaved 😀 source\r\n*ending", Order: 2}
	request := toolRequest{ProtocolVersion: 1, Operation: "quicktest", ProjectID: "original", Trusted: true}
	result, err := s.executeTool(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	raw, ok := result.(json.RawMessage)
	if !ok {
		t.Fatalf("unexpected broker result %T", result)
	}
	var captured struct {
		Request  toolRequest
		Captured []struct {
			URI, Text, TextFile string
			Version             int32
		}
	}
	if err = json.Unmarshal(raw, &captured); err != nil {
		t.Fatal(err)
	}
	if captured.Request.JobID == "" || len(captured.Captured) != 1 || captured.Captured[0].Text != s.buffers[uri].Text || captured.Captured[0].Version != 7 {
		t.Fatalf("job did not retain exact unsaved snapshot: %s", raw)
	}
	if _, err = os.Stat(captured.Captured[0].TextFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("snapshot remained after start acknowledgement", err)
	}
	if len(s.toolStarts) != 0 {
		t.Fatal("completed preparation remained registered")
	}
	if _, err = bridge.call(context.Background(), "error", nil); err == nil || !strings.Contains(err.Error(), "Original fixture rejection") {
		t.Fatal("broker rejection was hidden", err)
	}
	if _, err = bridge.call(context.Background(), "log", nil); err != nil {
		t.Fatal(err)
	}
	bridge.stale("original")
	deadline := time.Now().Add(2 * time.Second)
	for {
		status, err := bridge.call(context.Background(), "status", nil)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(status), "original") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("edit invalidation did not reach the broker")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = bridge.call(ctx, "wait", nil); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled broker request was not cancelled", err)
	}
	if _, err = s.executeTool(context.Background(), toolRequest{ProtocolVersion: 1, Operation: "stop", ProjectID: "original"}); err != nil {
		t.Fatal(err)
	}
	bridge.close()
	if _, err = bridge.start(); err == nil {
		t.Fatal("disposed bridge restarted a child")
	}
}

func TestToolBridgeRejectsUnsafeRequestsBeforeStarting(t *testing.T) {
	s, b := testToolBridge(t)
	for _, request := range []toolRequest{
		{ProtocolVersion: 2, Operation: "run", Trusted: true},
		{ProtocolVersion: 1, Operation: "run"},
		{ProtocolVersion: 1, Operation: "unknown", Trusted: true},
		{ProtocolVersion: 1, Operation: "createProject", Trusted: true},
		{ProtocolVersion: 1, Operation: "quicktest", ProjectID: "missing", Trusted: true},
	} {
		if _, err := s.executeTool(context.Background(), request); err == nil {
			t.Fatalf("unsafe request accepted: %+v", request)
		}
		if b.process != nil {
			t.Fatal("rejected request started game tooling")
		}
	}
	if _, err := s.executeTool(context.Background(), toolRequest{ProtocolVersion: 1, Operation: "stop", JobID: "not-started"}); err != nil {
		t.Fatal("stopping an absent job must be harmless", err)
	}
	missing := &toolBridge{}
	missing.stale("original")
	if _, err := missing.start(); err == nil {
		t.Fatal("missing runtime was accepted")
	}
	missing.close()
}

func TestToolBridgeReportsCrashesAndCanRestart(t *testing.T) {
	_, b := testToolBridge(t)
	first, err := b.start()
	if err != nil {
		t.Fatal(err)
	}
	if second, err := b.start(); err != nil || first != second {
		t.Fatal("active child was not reused", err)
	}
	if _, err = b.call(context.Background(), "crash", nil); err == nil {
		t.Fatal("broker crash was hidden")
	}
	if _, err = first.call(context.Background(), "status", nil); err == nil {
		t.Fatal("dead process accepted a new request")
	}
	b.stale("original")
	second, err := b.start()
	if err != nil || first == second {
		t.Fatal("failed broker could not be replaced", err)
	}
	if _, err = second.call(context.Background(), "status", nil); err != nil {
		t.Fatal(err)
	}
}

// Validate resident accounting with a live owned child, including its descendants;
// this checks the accounting contract without using instrumented timings as acceptance.
func TestOwnedBrokerResidentMemoryAndRemovalLifecycle(t *testing.T) {
	s, bridge := testToolBridge(t)
	if currentResidentBytes() <= 0 || peakResidentMiB() <= 0 {
		t.Fatal("current process resident accounting is unavailable")
	}
	process, err := bridge.start()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = process.call(context.Background(), "status", nil); err != nil {
		t.Fatal(err)
	}
	if process.owner.residentBytes() <= 0 {
		t.Fatal("owned broker memory was not counted")
	}
	root := t.TempDir()
	project := gameProject{ID: "original", AssetDir: root}
	for _, rel := range []string{"image.png", filepath.Join("images", "original Ω.png"), "scenes/startup.txt"} {
		if !nativeAssetAffects(project, filepath.Join(root, rel)) {
			t.Fatal("source-owned asset ignored", rel)
		}
	}
	for _, rel := range []string{".secret", ".git/config", "node_modules/a.js", "vendor/a.txt", "dist/log.txt", "build/log.txt", "export/game.html"} {
		if nativeAssetAffects(project, filepath.Join(root, filepath.FromSlash(rel))) {
			t.Fatal("generated or hidden output invalidated the source", rel)
		}
	}
	if nativeAssetAffects(project, filepath.Join(root, "..", "outside.png")) {
		t.Fatal("external file claimed as asset")
	}
	s.stopRemovedTools("original")
	s.handlers.Wait()
	bridge.close()
	if err = process.owner.Close(); err != nil {
		t.Fatal("owned process cleanup was not idempotent", err)
	}
	if process.owner.residentBytes() != 0 {
		t.Fatal("released process retained resident memory")
	}
}
