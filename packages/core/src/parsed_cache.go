package core

import (
	"encoding/gob"
	"errors"
	"io"
)

type parsedSnapshot struct {
	Version  uint32
	Document *Document
	Names    []string
	Values   []primitive
}

// WriteParsed captures detached syntax before AddParsed transfers ownership.
// Numeric arenas stream through bounded pages; metadata retains its descriptive
// encoding. This contains no semantic facts and never substitutes syntax for a
// complete project fixed point.
func (p *ParsedSource) WriteParsed(destination io.Writer) error {
	original := p.document
	metadata := *original
	metadata.Rows = nil
	metadata.Syntax = nil
	metadata.Exprs = nil
	metadata.Roots = nil
	metadata.Args = nil
	metadata.Widths = nil
	metadata.WordCounts = nil
	metadata.QuoteMarks = nil
	output := newSnapshotOutput(destination)
	if err := gob.NewEncoder(output.writer).Encode(parsedSnapshot{6, &metadata, p.names.Names, p.values.entries}); err != nil {
		return err
	}
	output.parsedRows(original)

	output.tokens(original.Syntax)
	output.u(uint64(len(original.Exprs)))
	for _, e := range original.Exprs {
		output.u(uint64(e.Kind))
		output.u(uint64(e.Op))
		output.u(uint64(e.Arg))
		output.u(uint64(e.A))
		output.u(uint64(e.B))
	}
	output.uints(original.Roots)
	output.uints(original.Args)
	output.metrics(original.Widths, original.widthMetrics)
	output.metrics(original.WordCounts, original.wordMetrics)
	output.u(uint64(len(original.QuoteMarks)))
	for _, mark := range original.QuoteMarks {
		output.u(uint64(mark.Column))
		output.u(uint64(mark.Kind))
		if mark.First {
			output.u(1)
		} else {
			output.u(0)
		}
	}
	output.flush()
	if output.err != nil {
		return output.err
	}
	return output.writer.Flush()
}
func ReadParsed(source io.Reader, identity Source) (*ParsedSource, error) {
	input := newSnapshotInput(source)
	var snapshot parsedSnapshot
	if err := gob.NewDecoder(input).Decode(&snapshot); err != nil {
		return nil, err
	}
	if snapshot.Version != 6 || snapshot.Document == nil {
		return nil, errors.New("invalid parsed-source snapshot")
	}
	d := snapshot.Document
	if err := input.parsedRows(d); err != nil {
		return nil, err
	}

	d.Syntax = input.tokens()
	d.Exprs = make([]expr, input.count(5))
	for i := range d.Exprs {
		d.Exprs[i] = expr{Kind: input.u8(), Op: input.u8(), Arg: input.u32(), A: input.u32(), B: input.u32()}
	}
	d.Roots = input.uints()
	d.Args = input.uints()
	d.Widths, d.widthMetrics = input.metrics()
	d.WordCounts, d.wordMetrics = input.metrics()
	d.QuoteMarks = make([]quoteMark, input.count(3))
	for i := range d.QuoteMarks {
		d.QuoteMarks[i] = quoteMark{Column: input.u32(), Kind: input.u8(), First: input.u8() != 0}
	}
	if input.err != nil {
		return nil, input.err
	}
	if err := validateParsedSnapshot(d, snapshot.Names); err != nil {
		return nil, err
	}
	if d.rowData != nil {
		d.rowData.packLinks()
	}
	d.syntaxDiagnostics = len(d.Diagnostics)
	d.URI, d.Version, d.Scene = identity.URI, identity.Version, sceneName(identity.URI)
	return &ParsedSource{document: d, names: registry{Names: snapshot.Names}, values: valuePool{entries: snapshot.Values}}, nil
}
func validateParsedSnapshot(d *Document, names []string) error {
	invalid := errors.New("inconsistent parsed-source snapshot")
	if d.RowCount() == 0 || len(d.Syntax) == 0 || len(d.Exprs) == 0 || len(names) == 0 || names[0] != "" || d.widthCount() != d.RowCount() || d.wordCountLen() != d.RowCount() {
		return invalid
	}
	d.nonBlankRows = 0
	for sourceRowIndex := range d.RowCount() {
		r := d.rowAt(sourceRowIndex)
		if sourceRowIndex != 0 && r.Kind != blank {
			d.nonBlankRows++
		}
		if r.Start > r.End || int(r.Command) >= len(names) || int(r.Target) >= len(names) || int(r.Parent) >= d.RowCount() || int(r.FirstChild) >= d.RowCount() || int(r.NextSibling) >= d.RowCount() || int(r.Expr) >= len(d.Exprs) || int(r.TargetExpr) >= len(d.Exprs) || uint64(r.ExprStart)+uint64(r.ExprCount) > uint64(len(d.Args)) || uint64(r.TokenStart)+uint64(r.TokenCount) > uint64(len(d.Syntax)) || int(r.TargetToken) >= len(d.Syntax) || r.Kind > metadata {
			return invalid
		}
	}
	for _, line := range d.Roots {
		if line == 0 || int(line) >= d.RowCount() {
			return invalid
		}
	}
	for _, id := range d.Args {
		if int(id) >= len(d.Exprs) {
			return invalid
		}
	}
	for token, name := range d.TokenName {
		if int(token) >= len(d.Syntax) || int(name) >= len(names) {
			return invalid
		}
	}
	for token, id := range d.TokenExpr {
		if int(token) >= len(d.Syntax) || int(id) >= len(d.Exprs) {
			return invalid
		}
	}
	for line, template := range d.Templates {
		if int(line) >= d.RowCount() || uint64(template.Start)+uint64(template.Count) > uint64(len(d.QuoteMarks)) {
			return invalid
		}
	}
	for _, t := range d.Syntax[1:] {
		if int(t.Line)+1 >= d.RowCount() || uint64(t.Start)+uint64(t.Length) > uint64(d.widthAt(t.Line+1)) || t.Type > Interpolation {
			return invalid
		}
	}
	return nil
}

func rowFields(r row) [20]uint32 {
	return [20]uint32{r.Start, r.End, r.Indent, r.IndentBytes, r.Arg, r.Command, r.Parent, r.FirstChild, r.NextSibling, r.Expr, r.TargetExpr, r.ExprStart, r.ExprCount, r.TokenStart, r.TokenCount, r.TargetToken, r.Target, r.Inline, uint32(r.Kind), uint32(r.Flags)}
}
func rowFromFields(f [20]uint32) row {
	return row{Start: f[0], End: f[1], Indent: f[2], IndentBytes: f[3], Arg: f[4], Command: f[5], Parent: f[6], FirstChild: f[7], NextSibling: f[8], Expr: f[9], TargetExpr: f[10], ExprStart: f[11], ExprCount: f[12], TokenStart: f[13], TokenCount: f[14], TargetToken: f[15], Target: f[16], Inline: f[17], Kind: uint8(f[18]), Flags: uint8(f[19])}
}
