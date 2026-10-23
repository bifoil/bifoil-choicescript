package core

import (
	"strings"
)

type literalDeclaration struct {
	Name   string
	Symbol uint32
}

// Record a dependency witness only after complete analysis. Dynamic addressing,
// arrays and source errors conservatively reject this proof. Every occurrence of
// a candidate name must be its sole declaration, across all scenes and routines.
func (p *Project) prepareLiteralDeclarations() {
	p.literalDeclarations = nil
	counts := make(map[uint32]int)
	for _, d := range p.Documents {
		for _, diagnostic := range d.Diagnostics {
			if diagnostic.Severity == 1 {
				return
			}
		}
		for _, name := range d.TokenName {
			counts[name]++
		}
		for _, index := range d.semanticRows() {
			n := d.rowAt(int(index))
			c := p.names.Names[n.Command]
			if c == "script" || c == "setref" || strings.HasSuffix(c, "_array") {
				return
			}
		}
		for _, e := range d.Exprs {
			if e.Kind == exIndirect || e.Kind == exArray {
				return
			}
		}
	}
	candidates := make(map[uint64]literalDeclaration)
	for doc, d := range p.Documents {
		for _, index := range d.semanticRows() {
			n := d.rowAt(int(index))
			if p.names.Names[n.Command] != "create" || n.Expr == 0 || d.Exprs[n.Expr].Kind != exLiteral || counts[n.Target] != 1 || n.TargetToken == 0 {
				continue
			}
			name := p.names.Names[n.Target]
			if name == "implicit_control_flow" || strings.HasPrefix(name, "choice_") || strings.HasPrefix(name, "param") || builtinType(name) != 0 {
				continue
			}
			t := p.TokenAt(uint32(doc), Position{Line: index - 1, Character: d.Syntax[n.TargetToken].Start})
			if t == nil || t.Symbol == 0 || p.Symbols[t.Symbol].Kind != "global" || p.unsafeRenames[t.Symbol] {
				continue
			}
			candidates[nodeID(uint32(doc), index-1)] = literalDeclaration{Name: name, Symbol: t.Symbol}
		}
	}
	p.literalDeclarations = candidates
}

func literalLine(text string) (*ParsedSource, []Token, bool) {
	if strings.ContainsAny(text, "\r\n") {
		return nil, nil, false
	}
	parsed := ParseSource(Source{URI: "file:///literal/startup.txt", Text: text})
	d := parsed.document
	if d.RowCount() != 2 || len(d.Diagnostics) != 0 || len(d.Syntax) != 4 {
		return nil, nil, false
	}
	n := d.rowAt(1)
	if n.Kind != command || parsed.names.Names[n.Command] != "create" || n.Expr == 0 || d.Exprs[n.Expr].Kind != exLiteral {
		return nil, nil, false
	}
	value, known := parsed.values.constant(Value(d.Exprs[n.Expr].Arg))
	if !known || Value(value.Kind) != BoolType && Value(value.Kind) != NumberType && Value(value.Kind) != StringType {
		return nil, nil, false
	}
	return parsed, d.Syntax[1:], true
}

// PatchUnusedLiteral updates a literal with no consumers in the completed dependency inventory.
// Relexing proves the command, binding, indentation and declaration prefix stay
// identical. All other flow/type/dialogue facts are therefore still complete;
// this updates the changed declaration's exact type and UTF-16 ranges only.
func (p *Project) PatchUnusedLiteral(doc, line uint32, before, after string, version int32) (*Project, bool) {
	proof, ok := p.literalDeclarations[nodeID(doc, line)]
	if !ok || int(doc) >= len(p.Documents) {
		return nil, false
	}
	previous, oldSyntax, ok := literalLine(before)
	if !ok {
		return nil, false
	}
	parsed, syntax, ok := literalLine(after)
	if !ok {
		return nil, false
	}
	oldNode, newNode := previous.document.rowAt(1), parsed.document.rowAt(1)
	if previous.names.Names[oldNode.Target] != proof.Name || parsed.names.Names[newNode.Target] != proof.Name {
		return nil, false
	}
	if before[:unitBytes(before, oldSyntax[2].Start)] != after[:unitBytes(after, syntax[2].Start)] {
		return nil, false
	}
	value, _ := parsed.values.constant(Value(parsed.document.Exprs[newNode.Expr].Arg))
	classification := Variable
	switch Value(value.Kind) {
	case BoolType:
		classification = BooleanVariable
	case NumberType:
		classification = NumberVariable
	case StringType:
		classification = StringVariable
	}
	old := p.Documents[doc]
	if int(line)+1 >= old.widthCount() || old.widthAt(line+1) != units(before) {
		return nil, false
	}
	tokens := p.TokenSequence(doc)
	first, last := p.tokenLineBounds(doc, line)
	if last-first != 3 {
		return nil, false
	}
	for i, span := range oldSyntax {
		actual := tokens.At(first + i)
		if actual.Start != span.Start || actual.Length != span.Length || i != 1 && actual.Type != span.Type {
			return nil, false
		}
	}
	if tokens.At(first+1).Symbol != proof.Symbol {
		return nil, false
	}
	q := *p
	q.Documents = append([]*Document(nil), p.Documents...)
	changed := *old
	changed.Version = version
	changed.updateLineMetrics(line+1, units(after), old.wordAt(line+1))
	q.Documents[doc] = &changed
	updated := make([]Token, last-first)
	for i := range updated {
		updated[i] = tokens.At(first + i)
	}
	for i, span := range syntax {
		updated[i].Start = span.Start
		updated[i].Length = span.Length
		updated[i].Type = span.Type
	}
	updated[1].Type = classification
	if !p.replaceQueryTokens(&q, doc, first, last, updated) {
		return nil, false
	}
	q.SymbolValues = append([]Value(nil), p.SymbolValues...)
	q.SymbolValues[proof.Symbol] = Value(value.Kind)
	return &q, true
}
