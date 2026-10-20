package main

import (
	"context"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

// Reusing byte-identical disk analysis avoids a complete second flow pass, but
// the editor still needs diagnostics for its newly opened document version.
// Paging shares the normal analysis owner and query lease; obsolete opens are
// checked again before publication and never relabel stale facts as current.
func (s *nativeServer) publishOpenedDiagnostics(uri string, version int32) {
	s.handlers.Go(func() {
		scope := &queryScope{}
		defer scope.close()
		ctx := context.WithValue(s.ctx, queryScopeKey{}, scope)
		p, doc, err := s.snapshot(ctx, uri)
		if err != nil || p == nil {
			return
		}
		s.mu.Lock()
		buffer, open := s.buffers[uri]
		project := s.projectLocked(uri)
		fresh := open && buffer.Version == version && project != nil && p.Revision == s.revisions[project.ID]
		s.mu.Unlock()
		if !fresh {
			return
		}
		diagnostics := p.Documents[doc].Diagnostics
		if diagnostics == nil {
			diagnostics = []core.Diagnostic{}
		}
		_ = s.stream.notify("textDocument/publishDiagnostics", map[string]any{"uri": uri, "version": version, "diagnostics": diagnostics})
	})
}
