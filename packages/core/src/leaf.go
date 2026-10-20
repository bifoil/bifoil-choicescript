package core

import (
	"fmt"
	"strings"
)

type effectKey struct {
	node     uint64
	argument uint32
}

// A straight-line routine can resolve indirect addresses from partition-stable
// arguments and preceding local definitions. Unresolved addresses or control flow
// reject this summary optimization; the ordinary complete transfer remains active.
func (p *Project) straightEffects(target uint64, args []Value) *callEffects {
	doc, line := uint32(target>>32), uint32(target)
	d := p.Documents[doc]
	result := &callEffects{needed: make(map[uint32]bool), written: make(map[uint32]bool)}
	result.needed[p.names.key(d.Scope, p.dynamicLocalName)] = true
	frame := make(map[uint32]Value)
	seen := make(map[uint32]bool)
	lookup := func(name uint32) Value {
		if value := frame[name]; value != 0 {
			return value
		}
		return UnknownType
	}
	eval := func(id uint32) Value { return evaluate(d, id, &p.names, &p.values, lookup) }
	add := func(name uint32, writes bool, scope int64) {
		scopes := []uint32{0, d.Scope}
		if scope >= 0 {
			scopes = []uint32{uint32(scope)}
		}
		for _, scope := range scopes {
			id := p.names.key(scope, name)
			result.needed[id] = true
			if writes {
				result.written[id] = true
			}
		}
	}
	address := func(id uint32) uint32 {
		value, ok := p.values.constant(eval(id))
		if !ok || Value(value.Kind) != StringType {
			return 0
		}
		return p.names.name(strings.ToLower(value.Text))
	}
	var inspect func(uint32) bool
	inspect = func(id uint32) bool {
		if id == 0 {
			return true
		}
		e := d.Exprs[id]
		switch e.Kind {
		case exVariable:
			add(e.Arg, false, -1)
			p.effectMemberRead(result, e.Arg, d.Scope)
		case exIndirect:
			if !inspect(e.A) {
				return false
			}
			name := address(e.A)
			if name == 0 {
				return false
			}
			add(name, false, -1)
			p.effectMemberRead(result, name, d.Scope)
			add(p.names.name(p.names.Names[name]+"_*"), false, -1)
		case exBinary:
			return inspect(e.A) && inspect(e.B)
		case exArray:
			for _, scope := range []uint32{0, d.Scope} {
				result.addArray(key{scope, e.Arg}, false)
			}
			for _, id := range d.Args[e.A : e.A+e.B] {
				if !inspect(id) {
					return false
				}
			}
		case exCall:
			for _, id := range d.Args[e.A : e.A+e.B] {
				if !inspect(id) {
					return false
				}
			}
		}
		return true
	}
	for line != 0 && !seen[line] {
		seen[line] = true
		n := d.rowAt(int(line))
		c := p.names.Names[n.Command]
		if c == "script" || metadataCommands[c] || blockCommands[c] || strings.HasPrefix(c, "goto") || strings.HasPrefix(c, "gosub") || c == "finish" || c == "ending" || c == "abort" || c == "restart" || strings.HasSuffix(c, "_array") || c == "create" {
			return nil
		}
		for token := n.TokenStart; token < n.TokenStart+n.TokenCount; token++ {
			if name := d.TokenName[token]; name != 0 {
				add(name, false, -1)
				add(p.names.name(p.names.Names[name]+"_*"), false, -1)
			}
			if !inspect(d.TokenExpr[token]) {
				return nil
			}
		}
		if !inspect(n.Expr) {
			return nil
		}
		if c == "setref" {
			if !inspect(n.TargetExpr) {
				return nil
			}
		} else if n.TargetExpr != 0 && d.Exprs[n.TargetExpr].Kind == exIndirect {
			if !inspect(d.Exprs[n.TargetExpr].A) {
				return nil
			}
		} else if !inspect(n.TargetExpr) {
			return nil
		}
		for _, expression := range d.rowSubstitutions(line) {
			if !inspect(expression) {
				return nil
			}
		}
		switch c {
		case "return":
			result.argumentCount = len(args)
			p.dropOverwrittenInputs(target, result)
			return result
		case "params":
			result.parameters = append(result.parameters, d.Scope)
			index := 0
			countName := p.names.name("param_count")
			frame[countName] = p.values.number(float64(len(args)))
			add(countName, true, int64(d.Scope))
			for token := n.TokenStart; token < n.TokenStart+n.TokenCount; token++ {
				name := d.TokenName[token]
				if name == 0 {
					continue
				}
				value := UnknownType
				if index < len(args) {
					value = args[index]
				}
				frame[name] = value
				add(name, true, int64(d.Scope))
				index++
			}
			for index, value := range args {
				name := p.names.name(fmt.Sprintf("param_%d", index+1))
				frame[name] = value
				add(name, true, int64(d.Scope))
			}
		case "temp", "set", "setref", "rand", "input_text", "input_number", "delete":
			name := n.Target
			if c == "setref" {
				name = address(n.TargetExpr)
			} else if n.TargetExpr != 0 {
				e := d.Exprs[n.TargetExpr]
				switch e.Kind {
				case exVariable:
					name = e.Arg
				case exIndirect:
					name = address(e.A)
				default:
					return nil
				}
			}
			if name == 0 {
				return nil
			}
			scope := int64(-1)
			if c == "temp" {
				scope = int64(d.Scope)
			}
			add(name, true, scope)
			value := eval(n.Expr)
			if c == "rand" || c == "input_number" {
				value = NumberType
			}
			if c == "input_text" {
				value = StringType
			}
			if c == "delete" {
				value = UnknownType
			}
			frame[name] = value
		}
		next := p.graphs[doc].targets(line)
		if len(next) != 1 {
			return nil
		}
		line = next[0]
	}
	return nil
}
