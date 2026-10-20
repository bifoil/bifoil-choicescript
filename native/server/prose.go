package main

import (
	"os"
	"strings"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

func bufferLine(text string, line uint32) (string, bool) {
	start, err := textOffset(text, core.Position{Line: line})
	if err != nil {
		return "", false
	}
	end := strings.IndexAny(text[start:], "\r\n")
	if end < 0 {
		return text[start:], true
	}
	return text[start : start+end], true
}
func (s *nativeServer) patchProseLocked(project gameProject, before, after openBuffer, changes []textChange) bool {
	if s.current == nil || s.currentID != project.ID || s.currentRevision != s.revisions[project.ID] || len(changes) == 0 {
		return false
	}
	lines := make(map[uint32]bool)
	for _, change := range changes {
		if change.Store != nil || change.Range == nil || change.Range.Start.Line != change.Range.End.Line || strings.ContainsAny(change.Text, "\r\n") {
			return false
		}
		lines[change.Range.Start.Line] = true
	}
	p := s.current
	doc, ok := nativeDocumentIndex(p, before.URI)
	if !ok {
		return false
	}
	for line := range lines {
		raw, ok := boundedRecipeLine(after, line)
		if !ok {
			return false
		}
		var accepted bool
		previous := p
		p, accepted = p.PatchPureProse(doc, line, raw, after.Version)
		if !accepted {
			original, ok := boundedRecipeLine(before, line)
			if !ok {
				return false
			}
			p, accepted = previous.PatchNarrativeSpan(doc, line, original, raw, after.Version)
			if !accepted {
				p, accepted = previous.PatchUnusedLiteral(doc, line, original, raw, after.Version)
				if !accepted {
					return false
				}
			}
		}
	}
	revision := s.revisions[project.ID] + 1
	p.Revision = revision
	old := s.indexes[project.ID]
	index := old
	index.revision = revision
	index.complete = true
	index.cacheFile = ""
	index.failure = ""
	index.bufferVersions = cloneBufferVersions(index.bufferVersions)
	index.bufferVersions[after.URI] = after.Version
	index.words = 0
	for i := range p.Documents {
		index.words += p.WordCount(uint32(i))
	}
	s.revisions[project.ID] = revision
	s.indexes[project.ID] = index
	s.current = p
	s.currentRevision = revision
	if old.cacheFile != "" {
		_ = os.Remove(old.cacheFile)
	}
	s.signalLocked()
	// The request reader retains ownership of document changes. The published
	// version lets the client reject this notification if a later edit overtakes it.
	diagnostics := p.Documents[doc].Diagnostics
	if diagnostics == nil {
		diagnostics = []core.Diagnostic{}
	}
	_ = s.stream.notify("textDocument/publishDiagnostics", map[string]any{"uri": after.URI, "version": after.Version, "diagnostics": diagnostics})
	return true
}
