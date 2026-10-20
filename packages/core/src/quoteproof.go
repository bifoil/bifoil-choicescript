package core

import (
	"fmt"
	"strings"
)

const familyRead uint32 = 1 << 31
const familyWrite uint32 = 1 << 30

type quoteConstraint struct {
	doc      uint32
	expr     uint32
	targets  []uint32
	source   uint32
	bad, any bool
}
type quoteProof struct {
	project      *Project
	defined, bad map[uint32]bool
	families     map[uint32]bool
	constraints  []quoteConstraint
	reverse      map[uint32][]int
	pending      []bool
	queue        []int
}

// This proof concerns one property only: whether a rendered value can contain a
// double quote. Every possible assignment contributes, across all scopes and
// branches. Failure to prove the property leaves the ordinary full flow active.
func (p *Project) prepareQuoteProof() {
	p.fixedText = make(map[uint64]uint64)
	p.fixedSubstitutions = make([]map[uint64]bool, len(p.Documents))
	proof := quoteProof{project: p, defined: make(map[uint32]bool), bad: make(map[uint32]bool), families: make(map[uint32]bool), reverse: make(map[uint32][]int)}
	parameterNames := make(map[uint32]bool)
	for _, d := range p.Documents {
		for _, e := range d.Exprs {
			if e.Kind == exArray {
				proof.families[e.Arg] = true
			}
		}
		for _, line := range d.semanticRows() {
			n := d.rowAt(int(line))
			n.Flags &^= 2
			d.setRow(int(line), n)
			c := p.names.Names[n.Command]
			if c == "create_array" || c == "temp_array" {
				proof.families[n.Target] = true
				proof.defined[p.names.name(p.names.Names[n.Target]+"_count")] = true
			}
			if n.Target != 0 && n.TargetExpr != 0 && d.Exprs[n.TargetExpr].Kind == exVariable {
				proof.defined[d.Exprs[n.TargetExpr].Arg] = true
			}
			if c == "params" {
				for token := n.TokenStart; token < n.TokenStart+n.TokenCount; token++ {
					if name := d.TokenName[token]; name != 0 {
						proof.defined[name] = true
						parameterNames[name] = true
					}
				}
			}
		}
	}
	for index, d := range p.Documents {
		for _, line := range d.semanticRows() {
			n := d.rowAt(int(line))
			c := p.names.Names[n.Command]
			constraint := quoteConstraint{doc: uint32(index), expr: n.Expr}
			switch c {
			case "script":
				constraint.bad = true
				constraint.any = true
			case "create_array", "temp_array":
				for _, id := range d.Args[n.ExprStart+min(n.ExprCount, 1) : n.ExprStart+n.ExprCount] {
					proof.constraints = append(proof.constraints, quoteConstraint{doc: uint32(index), expr: id, targets: []uint32{n.Target | familyWrite}})
				}
				continue
			case "create", "temp", "set", "setref", "rand", "input_text", "input_number":
				if c == "temp" && n.Expr == 0 {
					continue
				} // getVar rejects an uninitialized null before it can render.
				if c == "rand" || c == "input_number" {
					continue
				}
				constraint.bad = c == "input_text"
				if n.TargetExpr == 0 {
					continue
				}
				e := d.Exprs[n.TargetExpr]
				if c == "setref" {
					constraint.any = true
				} else {
					switch e.Kind {
					case exVariable:
						constraint.targets = []uint32{e.Arg}
					case exArray:
						constraint.targets = []uint32{e.Arg | familyWrite}
					default:
						constraint.any = true
					}
				}
			default:
				continue
			}
			proof.constraints = append(proof.constraints, constraint)
		}
	}
	// All argument sources constrain both named and generated parameters. An
	// unresolved call contributes unknown text rather than a guessed target.
	unknownCall := false
	for index, d := range p.Documents {
		for _, sourceRowIndex := range d.semanticRows() {
			n := d.rowAt(int(sourceRowIndex))
			c := p.names.Names[n.Command]
			if c != "gosub" && c != "gosub_scene" && c != "goto_scene" && c != "redirect_scene" {
				continue
			}
			target, _, _ := p.jump(d, n, 0, c)
			if uint32(target) == 0 {
				unknownCall = true
				continue
			}
			info := p.callParameters(target)
			if !info.known {
				unknownCall = true
				continue
			}
			refs := d.Args[n.ExprStart : n.ExprStart+n.ExprCount]
			offset := 1
			if c == "gosub_scene" || c == "goto_scene" || c == "redirect_scene" {
				offset = min(2, len(refs))
			}
			for i, id := range refs[offset:] {
				alias := p.names.name(fmt.Sprintf("param_%d", i+1))
				proof.defined[alias] = true
				targets := []uint32{alias}
				if i < len(info.names) {
					targets = append(targets, info.names[i])
				}
				proof.constraints = append(proof.constraints, quoteConstraint{doc: uint32(index), expr: id, targets: targets})
			}
		}
	}
	if unknownCall {
		for name := range parameterNames {
			proof.bad[name] = true
		}
	}
	// Read families include every valid field suffix, including string indices.
	pairs := make(map[uint64]bool)
	for _, d := range p.Documents {
		for _, name := range d.TokenName {
			for family := range proof.families {
				if strings.HasPrefix(p.names.Names[name], p.names.Names[family]+"_") {
					pair := uint64(name)<<32 | uint64(family)
					if pairs[pair] {
						continue
					}
					pairs[pair] = true
					proof.constraints = append(proof.constraints, quoteConstraint{source: name, targets: []uint32{family | familyRead}})
					proof.constraints = append(proof.constraints, quoteConstraint{source: family | familyWrite, targets: []uint32{name}})
				}
			}
		}
	}
	for family := range proof.families {
		proof.constraints = append(proof.constraints, quoteConstraint{source: family | familyWrite, targets: []uint32{family | familyRead}})
		if p.names.Names[family] == "choice" {
			proof.bad[family|familyRead] = true
		}
	}
	proof.pending = make([]bool, len(proof.constraints))
	for index, constraint := range proof.constraints {
		if constraint.source != 0 {
			proof.reverse[constraint.source] = append(proof.reverse[constraint.source], index)
		} else if !constraint.bad {
			for _, name := range proof.dependencies(p.Documents[constraint.doc], constraint.expr) {
				proof.reverse[name] = append(proof.reverse[name], index)
			}
		}
		proof.enqueue(index)
	}
	for head := 0; head < len(proof.queue); head++ {
		index := proof.queue[head]
		proof.pending[index] = false
		constraint := proof.constraints[index]
		bad := constraint.bad
		if constraint.source != 0 {
			bad = proof.bad[constraint.source]
		} else if !bad {
			bad = !proof.free(p.Documents[constraint.doc], constraint.expr)
		}
		if !bad {
			continue
		}
		if constraint.any {
			for name := range proof.defined {
				proof.mark(name)
			}
			for family := range proof.families {
				proof.mark(family | familyWrite)
			}
		} else {
			for _, name := range constraint.targets {
				proof.mark(name)
			}
		}
	}
	for index, d := range p.Documents {
		safe := make(map[uint64]bool)
		unsafeRows := make(map[uint32]bool)
		hasRows := make(map[uint32]bool)
		for location, expr := range d.Substitutions {
			row := uint32(location>>32) + 1
			hasRows[row] = true
			if proof.free(d, expr) {
				safe[location] = true
			} else {
				unsafeRows[row] = true
			}
		}
		p.fixedSubstitutions[index] = safe
		for line := range hasRows {
			n := d.rowAt(int(line))
			if unsafeRows[line] || n.Kind != prose && n.Kind != option || hasSourceDiagnostic(d, line-1, "interpolation-close") {
				continue
			}
			table, compiled := quoteFreeTable(proseBody(d.raw(line), n))
			if n.Kind == option {
				table = identityTextEffect
				compiled = true
			}
			if !compiled || p.slowQuoteTable {
				table = 0
				for slot := range uint8(14) {
					state := flowState{quote: slot/2 + 1, paragraph: slot%2 != 0}
					p.textTransfer(d, line, &state, false, 0, 0, false)
					table |= uint64(state.quote) << (slot * 3)
				}
			}
			n.Flags |= 2
			d.setRow(int(line), n)
			if table != identityTextEffect {
				p.fixedText[nodeID(uint32(index), line)] = table
			}
		}
	}
}
func hasSourceDiagnostic(d *Document, line uint32, code string) bool {
	for _, diagnostic := range d.Diagnostics {
		if diagnostic.Range.Start.Line == line && diagnostic.Code == code {
			return true
		}
	}
	return false
}
func (q *quoteProof) enqueue(index int) {
	if !q.pending[index] {
		q.pending[index] = true
		q.queue = append(q.queue, index)
	}
}
func (q *quoteProof) mark(name uint32) {
	if q.bad[name] {
		return
	}
	q.bad[name] = true
	for _, index := range q.reverse[name] {
		q.enqueue(index)
	}
}
func builtinQuoteFree(name string) bool {
	return name == "implicit_control_flow" || builtinType(name) != 0
}
func (q *quoteProof) variable(name uint32) bool {
	spelling := q.project.names.Names[name]
	if builtinQuoteFree(spelling) {
		return true
	}
	if strings.HasPrefix(spelling, "choice_") {
		return false
	}
	return q.defined[name] && !q.bad[name]
}
func (q *quoteProof) free(d *Document, id uint32) bool {
	if id == 0 {
		return false
	}
	e := d.Exprs[id]
	p := q.project
	switch e.Kind {
	case exLiteral:
		primitive, known := p.values.constant(Value(e.Arg))
		if !known {
			return false
		}
		if Value(primitive.Kind) != StringType {
			return true
		}
		return !containsSubstitution(primitive.Text) && !strings.ContainsAny(primitive.Text, "\"“”")
	case exVariable:
		return q.variable(e.Arg)
	case exArray:
		return !q.bad[e.Arg|familyRead]
	case exIndirect:
		inner := d.Exprs[e.A]
		if inner.Kind != exLiteral {
			return false
		}
		value, known := p.values.constant(Value(inner.Arg))
		if !known || Value(value.Kind) != StringType {
			return false
		}
		name, exists := p.names.names[strings.ToLower(value.Text)]
		return exists && q.variable(name)
	case exCall:
		return functionNames[p.names.Names[e.Arg]]
	case exBinary:
		if e.Op == 5 {
			return q.free(d, e.A) && q.free(d, e.B)
		}
		if e.Op == 9 {
			return q.free(d, e.A)
		}
		return e.Op > 0
	}
	return false
}
func (q *quoteProof) dependencies(d *Document, id uint32) []uint32 {
	if id == 0 {
		return nil
	}
	e := d.Exprs[id]
	switch e.Kind {
	case exVariable:
		return []uint32{e.Arg}
	case exArray:
		return []uint32{e.Arg | familyRead}
	case exBinary:
		if e.Op == 5 {
			return append(q.dependencies(d, e.A), q.dependencies(d, e.B)...)
		}
		if e.Op == 9 {
			return q.dependencies(d, e.A)
		}
	case exIndirect:
		inner := d.Exprs[e.A]
		if inner.Kind == exLiteral {
			if value, ok := q.project.values.constant(Value(inner.Arg)); ok && Value(value.Kind) == StringType {
				if name, exists := q.project.names.names[strings.ToLower(value.Text)]; exists {
					return []uint32{name}
				}
			}
		}
	}
	return nil
}

var identityTextEffect = func() uint64 {
	var result uint64
	for slot := range uint8(14) {
		result |= uint64(slot/2+1) << (slot * 3)
	}
	return result
}()

func (p *Project) flowText(d *Document, line uint32, quote uint8, paragraph bool) uint8 {
	return p.flowTextFlags(d, line, quote, paragraph, d.rowFlags(line))
}
func (p *Project) flowTextFlags(d *Document, line uint32, quote uint8, paragraph bool, flags uint8) uint8 {
	if flags&2 == 0 {
		return d.proseTransfer(line, quote, paragraph)
	}
	table := p.fixedText[nodeID(d.Scope-1, line)]
	if table == 0 {
		return quote
	}
	slot := (quote - 1) * 2
	if paragraph {
		slot++
	}
	return uint8(table >> (slot * 3) & 7)
}
