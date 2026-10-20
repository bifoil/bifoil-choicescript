package core

import (
	"encoding/binary"
	"maps"
	"sort"
	"strings"
)

// A return proof separates the output of an input-independent routine from its
// observational analysis. The ordinary fixed point still visits every body and
// records every reference. Callers can use a proven transfer immediately, without
// receiving provisional results widened by other callers. Failed proofs always
// use the ordinary interprocedural transfer.
type provedValue struct {
	value    Value
	argument int // 1-based formal argument; 0 denotes a fixed abstract value.
}
type returnWrite struct {
	scope, name uint32
	value       provedValue
}
type returnProof struct {
	doc      uint32
	lines    []proofLine
	observed bool
	writes   []returnWrite
	binds    bool
	transfer [14]uint8
}
type proofKey struct {
	target    uint64
	arguments string
}
type proofFrame map[uint32]provedValue

func (p *Project) proveReturn(target uint64, args []Value) *returnProof {
	argumentCount := len(args)
	signature := make([]byte, argumentCount*4)
	for i, value := range args {
		if _, ok := p.values.constant(value); ok {
			binary.LittleEndian.PutUint32(signature[i*4:], uint32(value))
		}
	}
	cacheKey := proofKey{target, string(signature)}
	if plan, ok := p.returnProofs[cacheKey]; ok {
		return plan
	}
	p.returnProofs[cacheKey] = nil
	doc, first := uint32(target>>32), uint32(target)
	d := p.Documents[doc]
	// Only finite local routines are candidates. Cyclic, nested and dynamic
	// routines remain fully analyzed by the normal call machinery.
	visiting := make(map[uint32]uint8)
	var order []uint32
	var visit func(uint32) bool
	visit = func(line uint32) bool {
		if visiting[line] == 1 {
			return false
		}
		if visiting[line] == 2 {
			return true
		}
		if len(visiting) >= 512 {
			return false
		}
		visiting[line] = 1
		n := d.rowAt(int(line))
		c := p.names.Names[n.Command]
		if n.Kind == option || n.Inline != noOffset || n.Kind == prose && n.Flags&3 == 0 {
			return false
		}
		switch c {
		case "return":
		case "goto", "gotoref":
			next, _, _ := p.jump(d, n, 0, c)
			if uint32(next) == 0 || uint32(next>>32) != doc || !visit(uint32(next)) {
				return false
			}
		default:
			if c != "" && c != "label" && c != "comment" && c != "if" && c != "elseif" && c != "elsif" && c != "else" && c != "params" && c != "temp" && c != "set" && c != "setref" && c != "rand" && c != "input_number" && c != "line_break" && c != "page_break" {
				return false
			}
			next := p.graphs[doc].targets(line)
			if len(next) == 0 {
				return false
			}
			for _, line := range next {
				if !visit(line) {
					return false
				}
			}
		}
		visiting[line] = 2
		order = append(order, line)
		return true
	}
	if first == 0 || !visit(first) {
		return nil
	}
	frames := map[uint32]proofFrame{first: {}}
	var identity [14]uint8
	for i := range identity {
		identity[i] = uint8(i/2+1) | uint8(i%2)*8
	}
	matrices := map[uint32][14]uint8{first: identity}
	matrixSeen := map[uint32]bool{first: true}
	consumed := map[uint32]uint8{first: 1}
	var finalMatrix [14]uint8
	finalSeen := false
	mergeMatrix := func(a, b [14]uint8) [14]uint8 {
		for i := range a {
			a[i] = (a[i]&7 | b[i]&7) | (a[i] & b[i] & 8)
		}
		return a
	}
	written := make(map[uint32]bool)
	binds := false
	var observations []proofLine
	var final proofFrame
	merge := func(left, right proofFrame) proofFrame {
		if left == nil {
			next := make(proofFrame, len(right))
			maps.Copy(next, right)
			return next
		}
		next := make(proofFrame, len(left)+len(right))
		for k, x := range left {
			y, ok := right[k]
			if !ok {
				next[k] = provedValue{}
				continue
			}
			if x == y {
				next[k] = x
			} else if x.argument == 0 && y.argument == 0 && x.value != 0 && y.value != 0 {
				next[k] = provedValue{value: p.values.join(x.value, y.value)}
			} else {
				next[k] = provedValue{}
			}
		}
		for k := range right {
			if _, ok := left[k]; !ok {
				next[k] = provedValue{}
			}
		}
		return next
	}
	for i := len(order) - 1; i >= 0; i-- {
		line := order[i]
		n := d.rowAt(int(line))
		c := p.names.Names[n.Command]
		frame := frames[line]
		if frame == nil {
			continue
		}
		entryMatrix := matrices[line]
		matrix := entryMatrix
		consumedHere := consumed[line]
		for slot, value := range matrix {
			if n.Kind == blank {
				matrix[slot] |= 8
			} else if n.Kind == prose {
				matrix[slot] = p.flowText(d, line, value&7, value&8 != 0)
			}
		}
		put := func(scope, name uint32, value provedValue) {
			id := p.names.key(scope, name)
			frame[id] = value
			written[id] = true
		}
		lookup := func(name uint32) Value {
			if value, ok := frame[p.names.key(d.Scope, name)]; ok {
				if value.argument == 0 && value.value != 0 {
					return value.value
				}
				return UnknownType
			}
			if _, ok := p.symbols[key{d.Scope, name}]; ok {
				return UnknownType
			}
			if value, ok := frame[p.names.key(0, name)]; ok && value.argument == 0 && value.value != 0 {
				return value.value
			}
			if value := builtinType(p.names.Names[name]); value != 0 {
				return value
			}
			return UnknownType
		}
		address := func(id uint32) uint32 {
			value := evaluate(d, id, &p.names, &p.values, func(name uint32) Value {
				if formal, ok := frame[p.names.key(d.Scope, name)]; ok && formal.argument != 0 {
					return args[formal.argument-1]
				}
				return lookup(name)
			})
			if primitive, ok := p.values.constant(value); ok && Value(primitive.Kind) == StringType {
				return p.names.name(strings.ToLower(primitive.Text))
			}
			return 0
		}
		eval := func(id uint32) provedValue {
			if id == 0 {
				return provedValue{}
			}
			e := d.Exprs[id]
			if e.Kind == exVariable {
				if value, ok := frame[p.names.key(d.Scope, e.Arg)]; ok {
					return value
				}
				if _, ok := p.symbols[key{d.Scope, e.Arg}]; ok {
					return provedValue{}
				}
				return frame[p.names.key(0, e.Arg)]
			}
			v := evaluate(d, id, &p.names, &p.values, lookup)
			if e.Kind == exLiteral {
				if _, ok := p.values.constant(v); ok {
					return provedValue{value: v}
				}
			}
			if v&15 == NumberType || v&15 == BoolType {
				return provedValue{value: v}
			}
			return provedValue{}
		}
		valueAtExpression := eval(n.Expr)
		facts, ok := p.proofFacts(d, line, frame, args, valueAtExpression)
		if !ok {
			return nil
		}
		observations = append(observations, proofLine{line, entryMatrix, facts})
		switch c {
		case "params":
			if consumedHere&2 != 0 {
				return nil
			}
			consumedHere = 2
			binds = true
			put(d.Scope, p.names.name("param_count"), provedValue{value: p.values.number(float64(argumentCount))})
			argument := 0
			for token := n.TokenStart; token < n.TokenStart+n.TokenCount; token++ {
				if name := d.TokenName[token]; name != 0 {
					argument++
					v := provedValue{value: UnknownType}
					if argument <= argumentCount {
						v = provedValue{argument: argument}
					}
					put(d.Scope, name, v)
					put(d.Scope, p.names.name(parameterAlias(argument)), v)
				}
			}
			for argument = 1; argument <= argumentCount; argument++ {
				put(d.Scope, p.names.name(parameterAlias(argument)), provedValue{argument: argument})
			}
		case "set", "setref", "temp", "rand", "input_number":
			name := n.Target
			if c == "setref" {
				name = address(n.TargetExpr)
			} else if n.TargetExpr != 0 {
				expression := d.Exprs[n.TargetExpr]
				if expression.Kind == exIndirect {
					name = address(expression.A)
				} else if expression.Kind != exVariable {
					return nil
				}
			}
			if name == 0 {
				return nil
			}
			if len(p.arrayBases) > 0 && numericBase(p.names.Names[name]) != p.names.Names[name] {
				return nil
			}
			scope := uint32(0)
			if c == "temp" {
				scope = d.Scope
			} else if _, ok := frame[p.names.key(d.Scope, name)]; ok {
				scope = d.Scope
			} else if _, ok := p.symbols[key{d.Scope, name}]; ok {
				return nil
			}
			value := eval(n.Expr)
			if c == "rand" || c == "input_number" {
				value = provedValue{value: NumberType}
			}
			if value.argument == 0 && value.value != 0 {
				if p.allConstants || p.constantNames[name] {
					if _, ok := p.values.constant(value.value); !ok {
						return nil
					}
				}
				value.value = p.bindingValue(name, value.value)
			}
			if value.value == 0 && value.argument == 0 {
				return nil
			}
			put(scope, name, value)
		case "return":
			final = merge(final, frame)
			if !finalSeen {
				finalMatrix = matrix
				finalSeen = true
			} else {
				finalMatrix = mergeMatrix(finalMatrix, matrix)
			}
			continue
		}
		send := func(next uint32) {
			consumed[next] |= consumedHere
			frames[next] = merge(frames[next], frame)
			if matrixSeen[next] {
				matrices[next] = mergeMatrix(matrices[next], matrix)
			} else {
				matrices[next] = matrix
				matrixSeen[next] = true
			}
		}
		if c == "goto" || c == "gotoref" {
			next, _, _ := p.jump(d, n, 0, c)
			send(uint32(next))
		} else {
			for _, next := range p.graphs[doc].targets(line) {
				send(next)
			}
		}
	}
	if final == nil {
		return nil
	}
	result := &returnProof{doc: doc, lines: observations, binds: binds, transfer: finalMatrix}
	for id := range written {
		v, ok := final[id]
		if !ok || v.argument == 0 && v.value == 0 {
			return nil
		}
		k := p.names.Keys[id]
		result.writes = append(result.writes, returnWrite{k.Scope, k.Name, v})
	}
	sort.Slice(result.writes, func(i, j int) bool {
		a, b := result.writes[i], result.writes[j]
		return a.scope < b.scope || a.scope == b.scope && a.name < b.name
	})
	p.returnProofs[cacheKey] = result
	return result
}
func (p *Project) provedReturn(plan *returnProof, state flowState, args []Value) flowState {
	p.observeProof(plan, state, args)
	for _, write := range plan.writes {
		value := write.value.value
		if write.value.argument != 0 {
			value = args[write.value.argument-1]
		}
		state.env = p.arena.set(state.env, p.names.key(write.scope, write.name), p.bindingValue(write.name, value))
	}
	// A binding *params consumes the pending argument registers. No subsequent
	// instruction in these routines can create another argument frame.
	if plan.binds {
		state.env = p.arena.normalize(p.arena.dropClass(state.env, 2, 0))
	}
	slot := (state.quote - 1) * 2
	if state.paragraph {
		slot++
	}
	output := plan.transfer[slot]
	state.quote = output & 7
	state.paragraph = output&8 != 0
	return state
}
