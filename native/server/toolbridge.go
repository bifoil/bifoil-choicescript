package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

type nativeOptions struct{ Bundle, Node string }
type toolRequest struct {
	ProtocolVersion int      `json:"protocolVersion"`
	Operation       string   `json:"operation"`
	ProjectID       string   `json:"projectId,omitempty"`
	Destination     string   `json:"destination,omitempty"`
	Iterations      *float64 `json:"iterations,omitempty"`
	Seed            *float64 `json:"seed,omitempty"`
	ShowText        bool     `json:"showText,omitempty"`
	JobID           string   `json:"jobId,omitempty"`
	Trusted         bool     `json:"trusted,omitempty"`
}
type capturedBuffer struct {
	URI      string `json:"uri"`
	Version  int32  `json:"version"`
	TextFile string `json:"textFile"`
}
type toolReply struct {
	ID     uint64          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}
type toolPending struct {
	ProjectID string
	Cancel    context.CancelFunc
}
type toolOutbound struct {
	ctx     context.Context
	value   any
	written chan error
}

type toolProcess struct {
	command       *exec.Cmd
	stream        io.WriteCloser
	owner         *ownedProcess
	done          chan struct{}
	outgoing      chan toolOutbound
	staleWake     chan struct{}
	dirtyProjects map[string]bool
	writerDone    chan struct{}
	mu            sync.Mutex
	next          uint64
	replies       map[uint64]chan toolReply
	failure       error
}
type toolBridge struct {
	mu      sync.Mutex
	server  *nativeServer
	options nativeOptions
	process *toolProcess
	closed  bool
}

func (b *toolBridge) start() (*toolProcess, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil, errors.New("Game tooling is shutting down.")
	}
	if b.process != nil {
		select {
		case <-b.process.done:
			b.process = nil
		default:
			return b.process, nil
		}
	}
	if b.options.Node == "" || b.options.Bundle == "" {
		return nil, errors.New("Bundled game tooling is unavailable; reinstall the plugin.")
	}
	cmd := exec.Command(b.options.Node, "--max-old-space-size=32", "--max-semi-space-size=2", filepath.Join(b.options.Bundle, "tool-broker.cjs"), b.options.Bundle)
	configureOwnedProcess(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		_ = stdout.Close()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdout.Close()
		_ = stdin.Close()
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	owner, err := ownProcess(cmd)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, err
	}
	process := &toolProcess{command: cmd, stream: stdin, owner: owner, done: make(chan struct{}), replies: make(map[uint64]chan toolReply), outgoing: make(chan toolOutbound), staleWake: make(chan struct{}, 1), dirtyProjects: make(map[string]bool), writerDone: make(chan struct{})}
	b.process = process
	go process.writeLoop()
	go func() {
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 4096), 65536)
		for scanner.Scan() {
			_ = b.server.stream.notify("window/logMessage", map[string]any{"type": 1, "message": "Game tooling: " + scanner.Text()})
		}
	}()
	go func() {
		decoder := json.NewDecoder(stdout)
		for {
			var reply toolReply
			if err = decoder.Decode(&reply); err != nil {
				break
			}
			if reply.Method != "" {
				_ = b.server.stream.notify(reply.Method, reply.Params)
				continue
			}
			process.mu.Lock()
			waiter := process.replies[reply.ID]
			delete(process.replies, reply.ID)
			process.mu.Unlock()
			if waiter != nil {
				waiter <- reply
			}
		}
		_ = stdin.Close()
		_ = owner.Close()
		waitErr := cmd.Wait()
		if waitErr != nil {
			err = waitErr
		}
		if err == nil || errors.Is(err, io.EOF) {
			err = errors.New("Game tooling stopped.")
		}
		process.mu.Lock()
		process.failure = err
		close(process.done)
		process.mu.Unlock()
	}()
	return process, nil
}
func (p *toolProcess) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	p.mu.Lock()
	if p.failure != nil {
		err := p.failure
		p.mu.Unlock()
		return nil, err
	}
	p.next++
	id := p.next
	reply := make(chan toolReply, 1)
	p.replies[id] = reply
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.replies, id); p.mu.Unlock() }()
	err := p.write(ctx, map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-p.done:
		p.mu.Lock()
		err := p.failure
		p.mu.Unlock()
		return nil, err
	case response := <-reply:
		if response.Error != nil {
			return nil, response.Error
		}
		return response.Result, nil
	}
}
func (b *toolBridge) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	p, err := b.start()
	if err != nil {
		return nil, err
	}
	return p.call(ctx, method, params)
}
func (b *toolBridge) stale(id string) {
	b.mu.Lock()
	p := b.process
	b.mu.Unlock()
	if p == nil {
		return
	}
	select {
	case <-p.done:
		return
	default:
	}
	// Coalesce edits without waiting for a pipe while the server lock is held.
	// The single writer owns all transport writes; starts retain pipe ordering.
	p.mu.Lock()
	p.dirtyProjects[id] = true
	p.mu.Unlock()
	select {
	case p.staleWake <- struct{}{}:
	default:
	}
}
func (b *toolBridge) close() {
	b.mu.Lock()
	b.closed = true
	p := b.process
	b.mu.Unlock()
	if p == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = p.call(ctx, "dispose", nil)
	_ = p.stream.Close()
	select {
	case <-p.done:
	case <-ctx.Done():
		_ = p.owner.Close()
		_ = p.command.Process.Kill()
		<-p.done
	}
	<-p.writerDone
}
func (s *nativeServer) executeTool(ctx context.Context, request toolRequest) (any, error) {
	if request.ProtocolVersion != 1 {
		return nil, &rpcError{-32602, "Expected protocolVersion 1."}
	}
	if request.Operation != "stop" && !request.Trusted {
		return nil, &rpcError{-32600, "Trust the workspace before running game code."}
	}
	if request.Operation == "stop" {
		s.mu.Lock()
		for id, pending := range s.toolStarts {
			if (request.JobID == "" || request.JobID == id) && (request.ProjectID == "" || request.ProjectID == pending.ProjectID) {
				pending.Cancel()
			}
		}
		s.mu.Unlock()
		s.tools.mu.Lock()
		p := s.tools.process
		s.tools.mu.Unlock()
		if p == nil {
			return map[string]string{"jobId": request.JobID, "projectId": request.ProjectID}, nil
		}
		return p.call(ctx, "job", map[string]any{"request": request})
	}
	if request.Operation == "createProject" {
		if request.Destination == "" {
			return nil, &rpcError{-32602, "Choose a project destination."}
		}
		result, err := s.tools.call(ctx, "job", map[string]any{"request": request})
		if err == nil {
			s.mu.Lock()
			s.roots = append(s.roots, request.Destination)
			s.mu.Unlock()
			s.refreshProjects()
		}
		return result, err
	}
	if request.Operation != "run" && request.Operation != "quicktest" && request.Operation != "randomtest" && request.Operation != "exportHtml" {
		return nil, &rpcError{-32602, "Unknown tooling operation."}
	}
	if request.JobID == "" {
		var bytes [16]byte
		if _, err := rand.Read(bytes[:]); err != nil {
			return nil, err
		}
		bytes[6] = bytes[6]&15 | 64
		bytes[8] = bytes[8]&63 | 128
		request.JobID = fmt.Sprintf("%x-%x-%x-%x-%x", bytes[:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:])
	}
	pendingCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	s.mu.Lock()
	var project *gameProject
	for i := range s.projects {
		if s.projects[i].ID == request.ProjectID {
			copy := s.projects[i]
			project = &copy
			break
		}
	}
	if project == nil || project.SingleFile != "" {
		s.mu.Unlock()
		return nil, errors.New("Select a detected ChoiceScript project.")
	}
	if _, exists := s.toolStarts[request.JobID]; exists {
		s.mu.Unlock()
		return nil, errors.New("Job ID is already in use.")
	}
	s.toolStarts[request.JobID] = toolPending{project.ID, cancel}
	var buffers []openBuffer
	for _, buffer := range s.buffers {
		if p := s.projectLocked(buffer.URI); p != nil && p.ID == project.ID {
			buffers = append(buffers, buffer)
		}
	}
	revision := s.revisions[project.ID]
	s.mu.Unlock()
	sort.Slice(buffers, func(i, j int) bool {
		if buffers[i].Order == buffers[j].Order {
			return buffers[i].URI < buffers[j].URI
		}
		return buffers[i].Order > buffers[j].Order
	})
	defer func() { s.mu.Lock(); delete(s.toolStarts, request.JobID); s.mu.Unlock() }()
	capture, err := os.MkdirTemp(s.cacheDir, "tool-snapshot-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(capture)
	refs := make([]capturedBuffer, 0, len(buffers))
	for i, buffer := range buffers {
		if err = pendingCtx.Err(); err != nil {
			return nil, err
		}
		file := filepath.Join(capture, fmt.Sprintf("%d.txt", i))
		f, e := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return nil, e
		}
		_, e = io.Copy(f, contextSourceReader{pendingCtx, bufferReader(buffer)})
		closeErr := f.Close()
		if e != nil {
			return nil, e
		}
		if closeErr != nil {
			return nil, closeErr
		}
		refs = append(refs, capturedBuffer{buffer.URI, buffer.Version, file})
	}
	result, err := s.tools.call(pendingCtx, "job", map[string]any{"request": request, "project": project, "buffers": refs})
	if pendingCtx.Err() != nil {
		stopCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, _ = s.tools.call(stopCtx, "job", map[string]any{"request": toolRequest{ProtocolVersion: 1, Operation: "stop", JobID: request.JobID, ProjectID: project.ID}})
		return nil, pendingCtx.Err()
	}
	s.mu.Lock()
	stale := s.revisions[project.ID] != revision
	s.mu.Unlock()
	if stale {
		s.tools.stale(project.ID)
	}
	return result, err
}

// Only advertised command IDs can dispatch their corresponding operation.
func toolCommandOperation(command string) string {
	switch command {
	case "bifoil.choicescript.server.createProject":
		return "createProject"
	case "bifoil.choicescript.server.run":
		return "run"
	case "bifoil.choicescript.server.stop":
		return "stop"
	case "bifoil.choicescript.server.quicktest":
		return "quicktest"
	case "bifoil.choicescript.server.randomtest":
		return "randomtest"
	case "bifoil.choicescript.server.exportHtml":
		return "exportHtml"
	}
	return ""
}
