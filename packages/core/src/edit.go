package core

import (
	"strings"
)

// PatchPureProse accepts a same-line edit only after proving that its complete
// fourteen-state quotation transfer is unchanged. All control flow, variable
// types, incoming dialogue states and other scenes therefore remain exact.
// Different syntax or transfer functions require ordinary project analysis.
func (p *Project) PatchPureProse(doc, line uint32, raw string, version int32) (*Project, bool) {
	if int(doc) >= len(p.Documents) || strings.ContainsAny(raw, "\r\n") {
		return nil, false
	}
	old := p.Documents[doc]
	rowIndex := line + 1
	if int(rowIndex) >= old.widthCount() || old.node(rowIndex).Kind != prose || old.node(rowIndex).Flags&1 == 0 || len(old.ProseEffects) != 0 && int(rowIndex) >= len(old.ProseEffects) {
		return nil, false
	}
	var names registry
	var values valuePool
	parsed := parseSource(Source{URI: old.URI, Text: raw, Version: version}, old.Scope, &names, &values)
	if parsed.RowCount() != 2 || parsed.rowAt(1).Kind != prose || parsed.rowAt(1).Flags&1 == 0 || parsed.rowAt(1).Indent != old.node(rowIndex).Indent || parsed.Templates[1].Exit != old.proseEffect(rowIndex) {
		return nil, false
	}
	state := flowState{quote: old.ProseEntries[rowIndex] & 7, paragraph: old.ProseEntries[rowIndex]&8 != 0}
	parsed.Diagnostics = nil
	spans := p.textTransfer(parsed, 1, &state, true, 0, 0, false)
	for i := range spans {
		spans[i].Line = line
	}
	diagnostics := make([]Diagnostic, 0, len(old.Diagnostics)+len(parsed.Diagnostics))
	for _, d := range old.Diagnostics {
		if d.Range.Start.Line == line && (d.Code == "quote-unexpected-close" || d.Code == "quote-branch") {
			continue
		}
		if d.Range.Start.Line == line && d.Range.End.Character == old.widthAt(rowIndex) {
			d.Range.End.Character = parsed.widthAt(1)
		}
		diagnostics = append(diagnostics, d)
	}
	for _, d := range parsed.Diagnostics {
		d.Range.Start.Line = line
		d.Range.End.Line = line
		diagnostics = append(diagnostics, d)
	}
	incoming := old.ProseEntries[rowIndex] & 7
	if p.QuoteWarnings && incoming != 7 && incoming&(incoming-1) != 0 {
		diagnostics = append(diagnostics, diagnostic(line, parsed.rowAt(1).Indent, max(uint32(1), parsed.widthAt(1)-parsed.rowAt(1).Indent), "quote-branch", "Incoming paths disagree about whether dialogue is open.", 2))
	}
	q := *p
	q.Documents = append([]*Document(nil), p.Documents...)
	changed := *old
	changed.Version = version
	changed.updateLineMetrics(rowIndex, parsed.widthAt(1), parsed.wordAt(1))
	if len(diagnostics) == 0 {
		diagnostics = nil
	}
	changed.Diagnostics = diagnostics
	q.Documents[doc] = &changed
	first, last := p.tokenLineBounds(doc, line)
	if !p.replaceQueryTokens(&q, doc, first, last, spans) {
		return nil, false
	}
	return &q, true
}
