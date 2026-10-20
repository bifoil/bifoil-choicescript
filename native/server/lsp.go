package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

type nativeIndex struct {
	documents      []string
	revision       uint64
	complete       bool
	scenes         int
	words          uint64
	failure        string
	cacheFile      string
	symbols        []core.Symbol
	bufferVersions map[string]int32
}
type nativeRequest struct{ cancel context.CancelFunc }

type nativeServer struct {
	bufferSerial         uint64
	revisionSerial       uint64
	receivingSources     uint32
	activeBufferVersions map[string]int32
	readers              int
	readersChanged       chan struct{}
	foregroundEpoch      uint64
	parseCache           *parseCache
	tools                *toolBridge
	toolStarts           map[string]toolPending
	stream               *rpcStream
	ctx                  context.Context
	cancel               context.CancelFunc
	mu                   sync.Mutex
	roots                []string
	projects             []gameProject
	buffers              map[string]openBuffer
	revisions            map[string]uint64
	indexes              map[string]nativeIndex
	requests             map[string]*nativeRequest
	preferred            string
	current              *core.Project
	currentID            string
	currentRevision      uint64
	activeID             string
	activeCancel         context.CancelFunc
	changed              chan struct{}
	wake                 chan struct{}
	worker               sync.WaitGroup
	handlers             sync.WaitGroup
	cacheDir             string
	quoteWarnings        bool
	shutdown             bool
	runtimeClose         sync.Once
	runtimeCloseErr      error
	stopResources        func()
	saveResourceReport   func()
}

func serveNative(r io.Reader, w io.Writer, options ...nativeOptions) error {
	var reportOnce sync.Once
	saveReport := func() { reportOnce.Do(writeResourceReport) }
	defer saveReport()
	cache, err := os.MkdirTemp("", "bifoil-language-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(cache)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &nativeServer{stream: newRPC(r, w), ctx: ctx, cancel: cancel, buffers: make(map[string]openBuffer), revisions: make(map[string]uint64), indexes: make(map[string]nativeIndex), requests: make(map[string]*nativeRequest), changed: make(chan struct{}), wake: make(chan struct{}, 1), cacheDir: cache, quoteWarnings: true, saveResourceReport: saveReport}
	s.stream.textDirectory = cache
	s.stream.sourceReadStarted = s.beginSourceRead
	var toolOptions nativeOptions
	if len(options) > 0 {
		toolOptions = options[0]
	}
	s.parseCache = newParseCache(ctx, filepath.Join(cache, "parsed"))
	s.tools = &toolBridge{server: s, options: toolOptions}
	s.toolStarts = make(map[string]toolPending)
	s.stopResources = monitorOwnedResources(s)
	defer s.stopResources()
	s.worker.Go(func() { s.analysisLoop() })
	defer func() {
		if err := s.closeRuntime(); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	for {
		message, e := s.stream.read()
		if e != nil {
			if errors.Is(e, io.EOF) {
				return nil
			}
			return e
		}
		if message.Method == "exit" {
			message.finishSourceRead()
			if !s.shutdown {
				return errors.New("client exited before shutdown")
			}
			return nil
		}
		if len(message.ID) == 0 {
			s.notification(message)
			message.finishSourceRead()
			message.Params = nil
			continue
		}
		message.finishSourceRead()
		if message.Method == "initialize" || message.Method == "shutdown" {
			result, e := s.request(ctx, message)
			if e = s.stream.respond(message.ID, result, e); e != nil {
				return e
			}
			continue
		}
		requestCtx, stop := context.WithCancel(ctx)
		scope := &queryScope{}
		requestCtx = context.WithValue(requestCtx, queryScopeKey{}, scope)
		id := string(message.ID)
		s.mu.Lock()
		if old := s.requests[id]; old != nil {
			old.cancel()
		}
		activeRequest := &nativeRequest{cancel: stop}
		s.requests[id] = activeRequest
		s.mu.Unlock()
		s.handlers.Add(1)
		go func(m rpcMessage) {
			defer s.handlers.Done()
			defer scope.close()
			defer stop()
			result, e := s.request(requestCtx, m)
			_ = s.stream.respond(m.ID, result, e)
			s.mu.Lock()
			if s.requests[id] == activeRequest {
				delete(s.requests, id)
			}
			s.mu.Unlock()
		}(message)
	}
}
func (s *nativeServer) signalLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
	select {
	case s.wake <- struct{}{}:
	default:
	}
}
func (s *nativeServer) invalidateLocked(id string) {
	if s.tools != nil {
		s.tools.stale(id)
	}
	s.revisionSerial++
	s.revisions[id] = s.revisionSerial
	index := s.indexes[id]
	index.complete = false
	index.failure = ""
	s.indexes[id] = index
	if s.currentID == id {
		s.current = nil
		s.currentID = ""
	}
	if s.activeID == id && s.activeCancel != nil {
		s.activeCancel()
	}
	s.signalLocked()
}
func (s *nativeServer) projectLocked(uri string) *gameProject {
	file, err := uriPath(uri)
	if err != nil {
		return nil
	}
	var result *gameProject
	for i := range s.projects {
		p := &s.projects[i]
		if nativeProjectContains(*p, file) && (result == nil || p.SingleFile != "" || len(p.SceneDir) > len(result.SceneDir)) {
			result = p
		}
	}
	return result
}
func (s *nativeServer) refreshProjects() {
	s.mu.Lock()
	roots := append([]string(nil), s.roots...)
	s.mu.Unlock()
	projects := discoverNativeProjects(roots, func(uri, message string) {
		_ = s.stream.notify("textDocument/publishDiagnostics", map[string]any{"uri": uri, "diagnostics": []core.Diagnostic{{Range: core.Range{}, Code: "project-configuration", Message: message, Severity: 1, Source: "Bifoil ChoiceScript"}}})
	})
	s.mu.Lock()
	projects = standaloneNativeProjects(projects, s.buffers)
	known := make(map[string]bool, len(projects))
	for _, project := range projects {
		known[project.ID] = true
		if _, exists := s.revisions[project.ID]; !exists {
			s.revisionSerial++
			s.revisions[project.ID] = s.revisionSerial
		}
	}
	var retired, cleared, removed []string
	for _, old := range s.projects {
		if known[old.ID] {
			continue
		}
		if s.activeID == old.ID && s.activeCancel != nil {
			s.activeCancel()
		}
		for _, pending := range s.toolStarts {
			if pending.ProjectID == old.ID {
				pending.Cancel()
			}
		}
		index := s.indexes[old.ID]
		cleared = append(cleared, index.documents...)
		removed = append(removed, old.ID)
		if index.cacheFile != "" {
			retired = append(retired, index.cacheFile)
		}
		delete(s.indexes, old.ID)
		delete(s.revisions, old.ID)
		if s.currentID == old.ID {
			s.current = nil
			s.currentID = ""
		}
		if s.preferred == old.ID {
			s.preferred = ""
		}
	}
	s.projects = projects
	s.signalLocked()
	s.mu.Unlock()
	for _, file := range retired {
		_ = os.Remove(file)
	}
	for _, uri := range cleared {
		_ = s.stream.notify("textDocument/publishDiagnostics", map[string]any{"uri": uri, "diagnostics": []core.Diagnostic{}})
	}
	for _, id := range removed {
		s.stopRemovedTools(id)
	}
	_ = s.stream.notify("choicescript/projectsChanged", map[string]any{"protocolVersion": 1, "projects": detectedNativeProjects(projects)})
}
func (s *nativeServer) notification(m rpcMessage) {
	switch m.Method {
	case "initialized":
		s.refreshProjects()
	case "$/cancelRequest":
		var p struct {
			ID json.RawMessage `json:"id"`
		}
		if json.Unmarshal(m.Params, &p) == nil {
			s.mu.Lock()
			if request := s.requests[string(p.ID)]; request != nil {
				request.cancel()
			}
			s.mu.Unlock()
		}
	case "textDocument/didOpen":
		var p struct {
			TextDocument struct {
				URI, LanguageID, Text string
				Version               int32
			} `json:"textDocument"`
		}
		if json.Unmarshal(m.Params, &p) != nil {
			return
		}
		d := p.TextDocument
		if _, err := uriPath(d.URI); err != nil {
			return
		}
		buffer := openBuffer{Explicit: d.LanguageID == "choicescript", URI: d.URI, Text: d.Text, Version: d.Version, Store: m.Sources["/params/textDocument/text"]}
		s.mu.Lock()
		reuse := false
		if project := s.projectLocked(d.URI); project != nil {
			index := s.indexes[project.ID]
			reuse = index.complete && !hasBufferOrigin(index.bufferVersions, d.URI) || s.activeID == project.ID && !hasBufferOrigin(s.activeBufferVersions, d.URI)
		}
		s.mu.Unlock()
		unchanged := false
		if file, e := uriPath(d.URI); e == nil && reuse {
			unchanged = s.bufferMatchesFile(buffer, file)
		}
		s.mu.Lock()
		if d.LanguageID != "choicescript" && s.projectLocked(d.URI) == nil {
			s.mu.Unlock()
			return
		}
		s.parseCache.forgetEdits(d.URI)
		s.bufferSerial++
		buffer.Order = s.bufferSerial
		s.buffers[d.URI] = buffer
		standalone := s.projectLocked(d.URI) == nil
		if err := s.boundOpenBuffersLocked(); err != nil {
			defer func() { _ = s.stream.notify("window/logMessage", map[string]any{"type": 1, "message": err.Error()}) }()
		}
		if project := s.projectLocked(d.URI); project != nil {
			s.preferred = project.ID
			if !unchanged {
				s.invalidateLocked(project.ID)
			} else {
				s.signalLocked()
			}
		}
		s.mu.Unlock()
		if standalone {
			s.refreshProjects()
		}
		if unchanged {
			s.publishOpenedDiagnostics(d.URI, d.Version)
		}
	case "textDocument/didChange":
		var p struct {
			TextDocument struct {
				URI     string
				Version int32
			} `json:"textDocument"`
			ContentChanges []textChange `json:"contentChanges"`
		}
		if json.Unmarshal(m.Params, &p) != nil {
			return
		}
		s.mu.Lock()
		for i := range p.ContentChanges {
			p.ContentChanges[i].Store = m.Sources[fmt.Sprintf("/params/contentChanges/%d/text", i)]
		}
		buffer, ok := s.buffers[p.TextDocument.URI]
		if ok {
			changed, err := changeBuffer(buffer, p.TextDocument.Version, p.ContentChanges)
			if err == nil {
				s.parseCache.recordEdits(buffer, changed, p.ContentChanges)
				s.bufferSerial++
				changed.Order = s.bufferSerial
				s.buffers[buffer.URI] = changed
				if err := s.boundOpenBuffersLocked(); err != nil {
					defer func() { _ = s.stream.notify("window/logMessage", map[string]any{"type": 1, "message": err.Error()}) }()
				}
				if project := s.projectLocked(buffer.URI); project != nil {
					s.preferred = project.ID
					if s.tools != nil {
						s.tools.stale(project.ID)
					}
					if !s.patchProseLocked(*project, buffer, changed, p.ContentChanges) {
						s.invalidateLocked(project.ID)
					}
				}
			} else {
				_ = s.stream.notify("window/logMessage", map[string]any{"type": 1, "message": "Could not apply document change: " + err.Error()})
			}
		}
		s.mu.Unlock()
	case "textDocument/didClose":
		var p struct {
			TextDocument struct{ URI string } `json:"textDocument"`
		}
		if json.Unmarshal(m.Params, &p) != nil {
			return
		}
		s.mu.Lock()
		buffer, open := s.buffers[p.TextDocument.URI]
		unchanged := false
		if open {
			if file, e := uriPath(buffer.URI); e == nil {
				unchanged = s.bufferMatchesFile(buffer, file)
			}
		}
		s.parseCache.forgetEdits(p.TextDocument.URI)
		delete(s.buffers, p.TextDocument.URI)
		standalone := false
		if project := s.projectLocked(p.TextDocument.URI); project != nil {
			standalone = project.SingleFile != ""
			if !unchanged {
				s.invalidateLocked(project.ID)
			}
		}
		s.mu.Unlock()
		if standalone {
			s.refreshProjects()
		}
	case "workspace/didChangeConfiguration":
		var p struct {
			Settings map[string]json.RawMessage `json:"settings"`
		}
		if json.Unmarshal(m.Params, &p) != nil {
			return
		}
		var options struct {
			QuoteWarnings *bool `json:"quoteWarnings"`
		}
		raw := p.Settings["bifoil.choicescript"]
		if len(raw) == 0 {
			var bifoil map[string]json.RawMessage
			_ = json.Unmarshal(p.Settings["bifoil"], &bifoil)
			raw = bifoil["choicescript"]
		}
		_ = json.Unmarshal(raw, &options)
		if options.QuoteWarnings != nil {
			s.mu.Lock()
			s.quoteWarnings = *options.QuoteWarnings
			for _, project := range s.projects {
				s.invalidateLocked(project.ID)
			}
			s.mu.Unlock()
		}
	case "workspace/didChangeWorkspaceFolders":
		var p struct {
			Event struct{ Added, Removed []struct{ URI string } } `json:"event"`
		}
		if json.Unmarshal(m.Params, &p) != nil {
			return
		}
		s.mu.Lock()
		for _, removed := range p.Event.Removed {
			for i := len(s.roots) - 1; i >= 0; i-- {
				if s.roots[i] == removed.URI {
					s.roots = append(s.roots[:i], s.roots[i+1:]...)
				}
			}
		}
		for _, added := range p.Event.Added {
			s.roots = append(s.roots, added.URI)
		}
		s.mu.Unlock()
		s.refreshProjects()
	case "workspace/didChangeWatchedFiles", "choicescript/assetChanged":
		var p struct {
			URI     string                 `json:"uri"`
			Changes []struct{ URI string } `json:"changes"`
		}
		if json.Unmarshal(m.Params, &p) != nil {
			return
		}
		uris := []string{p.URI}
		for _, change := range p.Changes {
			uris = append(uris, change.URI)
		}
		s.mu.Lock()
		for _, uri := range uris {
			s.parseCache.forgetDisk(uri)
			if project := s.projectLocked(uri); project != nil {
				s.invalidateLocked(project.ID)
			} else if file, err := uriPath(uri); err == nil {
				for _, project := range s.projects {
					if filepath.Base(file) == "choicescript.json" && filepath.Dir(file) == project.Root {
						s.invalidateLocked(project.ID)
					} else if nativeAssetAffects(project, file) && s.tools != nil {
						s.tools.stale(project.ID)
					}
				}
			}
		}
		s.mu.Unlock()
		s.refreshProjects()
	}
}
func (s *nativeServer) analysisLoop() {
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.wake:
		}
		// Coalesce initial project discovery and immediately arriving editor buffers
		// before starting work that those buffers would otherwise invalidate.
		s.mu.Lock()
		changed := s.changed
		s.mu.Unlock()
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-s.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		case <-changed:
			timer.Stop()
		case <-s.wake:
			timer.Stop()
		}
		for {
			s.mu.Lock()
			if s.shutdown || s.ctx.Err() != nil {
				s.mu.Unlock()
				return
			}
			if index := s.indexes[s.preferred]; index.complete && index.revision == s.revisions[s.preferred] && index.cacheFile != "" && (s.current == nil || s.currentID != s.preferred || s.currentRevision != index.revision) {
				if s.current != nil {
					target, epoch := s.preferred, s.foregroundEpoch
					s.mu.Unlock()
					err := s.evictCurrent()
					s.mu.Lock()
					if err != nil {
						s.failPagingLocked(target, err)
						s.mu.Unlock()
						continue
					}
					if s.foregroundEpoch != epoch {
						s.mu.Unlock()
						continue
					}
				}
				id, revision, file := s.preferred, index.revision, index.cacheFile
				s.mu.Unlock()
				if err := s.waitForQueries(); err != nil {
					return
				}
				f, e := os.Open(file)
				var p *core.Project
				if e == nil {
					p, e = core.ReadSnapshot(f)
					_ = f.Close()
				}
				s.mu.Lock()
				if s.revisions[id] == revision && e == nil {
					p.Revision = revision
					s.current = p
					s.currentID = id
					s.currentRevision = revision
				}
				if e != nil {
					index.failure = e.Error()
					index.complete = false
					s.indexes[id] = index
				}
				s.signalLocked()
				s.mu.Unlock()
				continue
			}
			var selected *gameProject
			for i := range s.projects {
				p := &s.projects[i]
				index := s.indexes[p.ID]
				if (index.complete && index.revision == s.revisions[p.ID]) || index.failure != "" {
					continue
				}
				if selected == nil || p.ID == s.preferred {
					copy := *p
					selected = &copy
				}
				if p.ID == s.preferred {
					break
				}
			}
			if selected == nil {
				s.mu.Unlock()
				break
			}
			if s.current != nil {
				target, epoch := selected.ID, s.foregroundEpoch
				s.mu.Unlock()
				err := s.evictCurrent()
				s.mu.Lock()
				if err != nil {
					s.failPagingLocked(target, err)
					s.mu.Unlock()
					continue
				}
				if s.foregroundEpoch != epoch {
					s.mu.Unlock()
					continue
				}
			}
			project := *selected
			revision := s.revisions[project.ID]
			warnings := s.quoteWarnings
			buffers := make(map[string]openBuffer)
			for uri, b := range s.buffers {
				if file, e := uriPath(uri); e == nil && inside(project.SceneDir, file) {
					buffers[uri] = b
				}
			}
			ctx, cancel := context.WithCancel(s.ctx)
			s.activeID = project.ID
			s.activeBufferVersions = bufferVersions(buffers)
			s.activeCancel = cancel
			s.mu.Unlock()
			if err := s.waitForQueries(); err != nil {
				cancel()
				return
			}
			started := time.Now()
			p := core.NewProject()
			p.QuoteWarnings = warnings
			p.Revision = revision
			_, files, _, err := loadNativeProject(ctx, project, p, buffers, s.parseCache)
			parsedAt := time.Now()
			if err == nil {
				err = p.Analyze(ctx)
			}
			analyzedAt := time.Now()
			var words uint64
			if err == nil {
				for i := range p.Documents {
					words += p.WordCount(uint32(i))
				}
				err = p.WaitForLargeSourceTransfers(ctx)
				if err == nil {
					p.CompactForQueries()
				}
			}
			if os.Getenv("BIFOIL_NATIVE_TIMINGS") != "" {
				fmt.Fprintf(os.Stderr, "native phases parse=%.1f semantic=%.1f compact=%.1f total=%.1f resident=%.1f peak=%.1f steps=%d error=%v\n", float64(parsedAt.Sub(started).Microseconds())/1000, float64(analyzedAt.Sub(parsedAt).Microseconds())/1000, float64(time.Since(analyzedAt).Microseconds())/1000, float64(time.Since(started).Microseconds())/1000, float64(currentResidentBytes())/1048576, peakResidentMiB(), p.Steps, err)
			}
			cancel()
			s.mu.Lock()
			s.activeID = ""
			s.activeBufferVersions = nil
			s.activeCancel = nil
			if current, exists := s.revisions[project.ID]; !exists || current != revision || errors.Is(err, context.Canceled) || s.ctx.Err() != nil {
				s.mu.Unlock()
				p = nil
				// Return retired snapshot pages to the OS promptly. Heap collection alone
				// can leave the Windows working set resident throughout an official run.
				debug.FreeOSMemory()
				continue
			}
			old := s.indexes[project.ID]
			index := nativeIndex{revision: revision, scenes: files, words: words, complete: err == nil, symbols: append([]core.Symbol(nil), p.Symbols...), bufferVersions: bufferVersions(buffers)}
			for _, document := range p.Documents {
				index.documents = append(index.documents, document.URI)
			}
			if err != nil {
				index.failure = err.Error()
			}
			s.indexes[project.ID] = index
			if err == nil && (s.preferred == project.ID || s.current == nil) {
				s.current = p
				s.currentID = project.ID
				s.currentRevision = revision
			}
			s.signalLocked()
			s.mu.Unlock()
			if old.cacheFile != "" {
				_ = os.Remove(old.cacheFile)
			}
			if err != nil {
				_ = s.stream.notify("window/logMessage", map[string]any{"type": 1, "message": "Complete ChoiceScript analysis failed: " + err.Error()})
			} else {
				s.publish(p, project.ID, revision)
			}
			p = nil
			// Return retired snapshot pages to the OS promptly. Heap collection alone
			// can leave the Windows working set resident throughout an official run.
			debug.FreeOSMemory()
		}
	}
}
func (s *nativeServer) publish(p *core.Project, id string, revision uint64) {
	for _, d := range p.Documents {
		s.mu.Lock()
		fresh := s.revisions[id] == revision
		buffer, open := s.buffers[d.URI]
		s.mu.Unlock()
		if !fresh {
			return
		}
		params := map[string]any{"uri": d.URI, "diagnostics": d.Diagnostics}
		if d.Diagnostics == nil {
			params["diagnostics"] = []core.Diagnostic{}
		}
		if open {
			params["version"] = buffer.Version
		}
		_ = s.stream.notify("textDocument/publishDiagnostics", params)
	}
}
func (s *nativeServer) snapshot(ctx context.Context, uri string) (*core.Project, uint32, error) {
	recorded := false
	for {
		s.mu.Lock()
		project := s.projectLocked(uri)
		if project == nil {
			s.mu.Unlock()
			return nil, 0, nil
		}
		id := project.ID
		s.preferred = id
		revision := s.revisions[id]
		if s.current != nil && s.currentID == id && s.currentRevision == revision {
			p := s.current
			s.retainQueryLocked(ctx)
			s.mu.Unlock()
			doc, ok := nativeDocumentIndex(p, uri)
			if !ok {
				return nil, 0, errors.New("document was not part of the complete snapshot")
			}
			return p, doc, nil
		}
		if !recorded {
			s.foregroundEpoch++
			recorded = true
		}
		index := s.indexes[id]
		if index.failure != "" {
			s.mu.Unlock()
			return nil, 0, errors.New(index.failure)
		}
		if s.activeID != "" && s.activeID != id && s.activeCancel != nil {
			s.activeCancel()
		}
		changed := s.changed
		if index.complete && index.revision == revision && index.cacheFile != "" {
			// Only the analysis owner loads pages, avoiding duplicate large decodes when
			// hover, highlighting and completion arrive together.
			select {
			case s.wake <- struct{}{}:
			default:
			}
			s.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, 0, ctx.Err()
			case <-changed:
			}
			continue
		}
		select {
		case s.wake <- struct{}{}:
		default:
		}
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, 0, ctx.Err()
		case <-s.ctx.Done():
			return nil, 0, s.ctx.Err()
		case <-changed:
		}
	}
}
func (s *nativeServer) request(ctx context.Context, m rpcMessage) (result any, failure error) {
	if ctx.Value(queryScopeKey{}) == nil {
		scope := &queryScope{}
		ctx = context.WithValue(ctx, queryScopeKey{}, scope)
		defer scope.close()
	}
	if m.Method != "shutdown" {
		defer func() {
			if err := ctx.Err(); err != nil {
				result = nil
				failure = err
			}
		}()
	}
	switch m.Method {
	case "initialize":
		var p struct {
			WorkspaceFolders      []struct{ URI string }        `json:"workspaceFolders"`
			RootURI               string                        `json:"rootUri"`
			InitializationOptions struct{ QuoteWarnings *bool } `json:"initializationOptions"`
		}
		if err := json.Unmarshal(m.Params, &p); err != nil {
			return nil, &rpcError{-32602, "Invalid initialize parameters."}
		}
		s.mu.Lock()
		for _, folder := range p.WorkspaceFolders {
			s.roots = append(s.roots, folder.URI)
		}
		if len(s.roots) == 0 && p.RootURI != "" {
			s.roots = []string{p.RootURI}
		}
		if p.InitializationOptions.QuoteWarnings != nil {
			s.quoteWarnings = *p.InitializationOptions.QuoteWarnings
		}
		s.mu.Unlock()
		return map[string]any{"serverInfo": map[string]string{"name": "Bifoil ChoiceScript (Unofficial)", "version": "0.1.0"}, "capabilities": map[string]any{"textDocumentSync": 2, "executeCommandProvider": map[string]any{"commands": []string{"bifoil.choicescript.server.createProject", "bifoil.choicescript.server.run", "bifoil.choicescript.server.stop", "bifoil.choicescript.server.quicktest", "bifoil.choicescript.server.randomtest", "bifoil.choicescript.server.exportHtml"}}, "completionProvider": map[string]any{"triggerCharacters": []string{"*", "{"}}, "hoverProvider": true, "definitionProvider": true, "referencesProvider": true, "renameProvider": map[string]bool{"prepareProvider": true}, "documentSymbolProvider": true, "workspaceSymbolProvider": true, "foldingRangeProvider": true, "selectionRangeProvider": true, "semanticTokensProvider": map[string]any{"legend": map[string]any{"tokenTypes": core.TokenTypes, "tokenModifiers": core.TokenModifiers}, "full": true}, "workspace": map[string]any{"workspaceFolders": map[string]bool{"supported": true, "changeNotifications": true}}}}, nil
	case "shutdown":
		return nil, s.closeRuntime()
	case "choicescript/job", "workspace/executeCommand":
		var raw = json.RawMessage(m.Params)
		commandOperation := ""
		if m.Method == "workspace/executeCommand" {
			var args struct {
				Command   string
				Arguments []json.RawMessage
			}
			if json.Unmarshal(m.Params, &args) != nil || len(args.Arguments) != 1 || toolCommandOperation(args.Command) == "" {
				return nil, &rpcError{-32602, "Invalid tooling command."}
			}
			commandOperation = toolCommandOperation(args.Command)
			raw = args.Arguments[0]
		}
		var job toolRequest
		if json.Unmarshal(raw, &job) != nil {
			return nil, &rpcError{-32602, "Invalid tooling request."}
		}
		if commandOperation != "" && job.Operation != commandOperation {
			return nil, &rpcError{-32602, "Tooling command and operation disagree."}
		}
		return s.executeTool(ctx, job)
	case "choicescript/projects":
		s.mu.Lock()
		projects := detectedNativeProjects(s.projects)
		s.mu.Unlock()
		return projects, nil
	case "choicescript/indexStatus":
		s.mu.Lock()
		defer s.mu.Unlock()
		result := []map[string]any{}
		for _, project := range s.projects {
			index := s.indexes[project.ID]
			failures := 0
			if index.failure != "" {
				failures = 1
			}
			result = append(result, map[string]any{"projectId": project.ID, "scenes": index.scenes, "indexed": index.scenes, "words": index.words, "failures": failures, "complete": index.complete && index.revision == s.revisions[project.ID], "limited": false})
		}
		return result, nil
	case "workspace/symbol":
		var args struct{ Query string }
		_ = json.Unmarshal(m.Params, &args)
		s.mu.Lock()
		defer s.mu.Unlock()
		result := []map[string]any{}
		for _, project := range s.projects {
			index := s.indexes[project.ID]
			if !index.complete || index.revision != s.revisions[project.ID] {
				return nil, &rpcError{-32801, "Complete workspace analysis is not ready."}
			}
			for _, symbol := range index.symbols {
				if symbol.Kind != "" && strings.Contains(strings.ToLower(symbol.Name), strings.ToLower(args.Query)) {
					result = append(result, map[string]any{"name": symbol.Name, "kind": 13, "location": symbol.Location})
				}
			}
		}
		return result, nil
	}
	var args struct {
		TextDocument struct{ URI string }              `json:"textDocument"`
		URI          string                            `json:"uri"`
		Position     core.Position                     `json:"position"`
		Positions    []core.Position                   `json:"positions"`
		NewName      string                            `json:"newName"`
		Context      struct{ IncludeDeclaration bool } `json:"context"`
	}
	if err := json.Unmarshal(m.Params, &args); err != nil {
		return nil, &rpcError{-32602, "Invalid language request parameters."}
	}
	uri := args.TextDocument.URI
	if uri == "" {
		uri = args.URI
	}
	switch m.Method {
	case "textDocument/hover", "textDocument/completion", "textDocument/definition", "textDocument/references", "textDocument/prepareRename", "textDocument/rename", "textDocument/documentSymbol", "textDocument/foldingRange", "textDocument/selectionRange", "textDocument/semanticTokens/full", "choicescript/wordCount":
	default:
		return nil, &rpcError{-32601, "Method not found: " + m.Method}
	}
	p, doc, err := s.snapshot(ctx, uri)
	if err != nil || p == nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	project := s.projectLocked(uri)
	id := ""
	var revision uint64
	if project != nil {
		id = project.ID
		revision = p.Revision
	}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		fresh := id != "" && s.revisions[id] == revision
		s.mu.Unlock()
		if !fresh && failure == nil {
			result = nil
			failure = &rpcError{-32801, "Document changed during the request."}
		}
	}()

	switch m.Method {
	case "textDocument/hover":
		return p.Hover(doc, args.Position), nil
	case "textDocument/definition":
		return p.Definition(doc, args.Position), nil
	case "textDocument/references":
		return p.References(doc, args.Position, args.Context.IncludeDeclaration), nil
	case "textDocument/prepareRename":
		return p.PrepareRename(doc, args.Position), nil
	case "textDocument/rename":
		edit, e := p.Rename(doc, args.Position, args.NewName)
		if e != nil {
			return nil, &rpcError{-32602, e.Error()}
		}
		return edit, nil
	case "textDocument/documentSymbol":
		return p.DocumentSymbols(doc), nil
	case "textDocument/foldingRange":
		return p.Folding(doc), nil
	case "textDocument/selectionRange":
		return p.Selections(doc, args.Positions), nil
	case "textDocument/semanticTokens/full":
		return semanticTokenResponse{context: ctx, sequence: p.TokenSequence(doc)}, nil
	case "choicescript/wordCount":
		return p.WordCount(doc), nil
	case "textDocument/completion":
		s.mu.Lock()
		file, _ := uriPath(uri)
		buffer, open := latestNativeBuffer(file, s.buffers)
		s.mu.Unlock()
		prefix, closeSource, err := newCompletionPrefix(ctx, uri, buffer, open, args.Position)
		if err != nil {
			return nil, err
		}
		defer closeSource()
		result := p.CompletionsReader(doc, args.Position, prefix.runes)
		if prefix.failure != nil {
			return nil, prefix.failure
		}
		return result, nil
	}
	return nil, nil
}
