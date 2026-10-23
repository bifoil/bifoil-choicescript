package core

import (
	"context"
	"strings"
)

// SourceLineEdit describes an exact same-line transformation from an immutable
// parsed baseline. The host creates recipes from validated document edits; no
// caller-supplied pathname or cache record is adopted.
type SourceLineEdit struct{ Before, After string }

func simpleLiteralLine(ctx context.Context, text string) (*ParsedSource, row, bool, error) {
	if strings.ContainsAny(text, "\r\n") {
		return nil, row{}, false, nil
	}
	parsed, err := ParseSourceContext(ctx, Source{URI: "file:///line/startup.txt", Text: text})
	if err != nil {
		return nil, row{}, false, err
	}
	d := parsed.document
	if d.RowCount() != 2 || len(d.Diagnostics) != 0 {
		return nil, row{}, false, nil
	}
	n := d.rowAt(1)
	c := parsed.names.Names[n.Command]
	if c != "create" && c != "temp" && c != "set" && c != "print" && c != "looplimit" {
		return nil, row{}, false, nil
	}
	if n.Expr == 0 || d.Exprs[n.Expr].Kind != exLiteral || n.Inline != noOffset {
		return nil, row{}, false, nil
	}
	if _, known := parsed.values.constant(Value(d.Exprs[n.Expr].Arg)); !known {
		return nil, row{}, false, nil
	}
	return parsed, n, true, nil
}

// CanReuseSourceLine accepts only ordinary prose without syntax islands or one
// literal assignment/output with an unchanged declaration/command prefix. This
// proves lexical shape only. Reuse still runs the entire project fixed point.
func CanReuseSourceLine(before, after string) bool {
	_, _, ok, err := literalSourcePair(context.Background(), before, after)
	if err == nil && ok {
		return true
	}
	if strings.ContainsAny(before, "\r\n\"“”$@[]{}*#|") || strings.ContainsAny(after, "\r\n\"“”$@[]{}*#|") {
		return false
	}
	left, right := leading(before)
	next, nextUnits := leading(after)
	return trim(before) != "" && trim(after) != "" && right == nextUnits && before[:left] == after[:next]
}
func literalSourcePair(ctx context.Context, before, after string) (*ParsedSource, *ParsedSource, bool, error) {
	old, a, ok, err := simpleLiteralLine(ctx, before)
	if err != nil || !ok {
		return nil, nil, false, err
	}
	next, b, ok, err := simpleLiteralLine(ctx, after)
	if err != nil || !ok {
		return nil, nil, false, err
	}
	if old.names.Names[a.Command] != next.names.Names[b.Command] || len(old.document.Syntax) != len(next.document.Syntax) {
		return nil, nil, false, nil
	}
	left, right := old.document.Syntax[len(old.document.Syntax)-1], next.document.Syntax[len(next.document.Syntax)-1]
	if before[:unitBytes(before, left.Start)] != after[:unitBytes(after, right.Start)] {
		return nil, nil, false, nil
	}
	return old, next, true, nil
}

// ApplySourceLineEdit consumes a privately owned detached parse. It replaces
// lexical facts and precise extents only; callers must subsequently run Analyze
// over the complete project. Unsupported structural edits request an ordinary
// full parse instead. A cancelled mutation must be discarded by its owner.
func (p *ParsedSource) ApplySourceLineEdit(ctx context.Context, line uint32, edit SourceLineEdit, version int32) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	d := p.document
	index := line + 1
	if d == nil || index >= uint32(d.RowCount()) || d.widthAt(index) != units(edit.Before) {
		return false, nil
	}
	for _, diagnostic := range d.Diagnostics {
		if diagnostic.Range.Start.Line == line {
			return false, nil
		}
	}
	n := d.rowAt(int(index))
	previous, next, literal, err := literalSourcePair(ctx, edit.Before, edit.After)
	if err != nil {
		return false, err
	}
	if literal {
		oldNode, newNode := previous.document.rowAt(1), next.document.rowAt(1)
		if n.Kind != command || n.Expr == 0 || d.Exprs[n.Expr].Kind != exLiteral || p.names.Names[n.Command] != previous.names.Names[oldNode.Command] || n.TokenCount != oldNode.TokenCount || d.raw(index) != edit.Before {
			return false, nil
		}
		if d.Exprs[n.Expr].Arg>>4 >= uint32(len(p.values.entries)) {
			return false, nil
		}
		value, _ := next.values.constant(Value(next.document.Exprs[newNode.Expr].Arg))
		// Every source-literal ID is checked before mutation. Compaction below prevents
		// a long typing session from retaining all previous string values.
		for _, e := range d.Exprs {
			if e.Kind == exLiteral && e.Arg>>4 >= uint32(len(p.values.entries)) {
				return false, nil
			}
		}
		p.values.entries = append(p.values.entries, value)
		d.Exprs[n.Expr].Arg = uint32(len(p.values.entries)-1)<<4 | uint32(value.Kind)
		for i := uint32(0); i < n.TokenCount; i++ {
			token := next.document.Syntax[newNode.TokenStart+i]
			token.Line = line
			d.Syntax[n.TokenStart+i] = token
		}
		d.RawRows[index] = strings.Clone(edit.After)
		p.compactSourceValues()
	} else {
		if !CanReuseSourceLine(edit.Before, edit.After) || n.Kind != prose || n.Flags&1 == 0 || n.TokenCount != 0 || d.Templates[index].Count != 0 {
			return false, nil
		}
		parsed, e := ParseSourceContext(ctx, Source{URI: d.URI, Text: edit.After})
		if e != nil {
			return false, e
		}
		row := parsed.document.rowAt(1)
		if row.Kind != prose || row.Flags&1 == 0 || row.TokenCount != 0 || len(parsed.document.QuoteMarks) != 0 || row.Indent != n.Indent {
			return false, nil
		}
		d.updateLineMetrics(index, units(edit.After), parsed.document.wordAt(1))
	}
	if literal {
		d.updateLineMetrics(index, units(edit.After), d.wordAt(index))
	}
	delta := int64(len(edit.After)) - int64(len(edit.Before))
	lines := d.semanticRows()
	if d.rowData == nil {
		lines = make([]uint32, 0, d.RowCount())
		for i := uint32(1); i < uint32(d.RowCount()); i++ {
			lines = append(lines, i)
		}
	}
	for _, at := range lines {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		if at < index {
			continue
		}
		r := d.rowAt(int(at))
		if at > index {
			r.Start = uint32(int64(r.Start) + delta)
		}
		r.End = uint32(int64(r.End) + delta)
		d.setRow(int(at), r)
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	d.Version = version
	return true, nil
}
func (p *ParsedSource) compactSourceValues() {
	d := p.document
	remap := make([]uint32, len(p.values.entries))
	values := []primitive{{}}
	for i := range d.Exprs {
		e := &d.Exprs[i]
		if e.Kind != exLiteral || e.Arg>>4 == 0 {
			continue
		}
		old := e.Arg >> 4
		if remap[old] == 0 {
			remap[old] = uint32(len(values))
			values = append(values, p.values.entries[old])
		}
		e.Arg = remap[old]<<4 | e.Arg&15
	}
	p.values = valuePool{entries: values}
}
