package core

import (
	"fmt"
	"strings"
)

// Stable arguments can name variables even inside conditional routines. Reject
// any frame entry that the reachable routine can overwrite; unresolved writes
// and nested calls retain the ordinary whole-environment analysis.
func (p *Project) stableRoutineFrame(target uint64, args []Value) map[uint32]Value {
	info := p.callParameters(target)
	frame := make(map[uint32]Value)
	if info.known && info.binds {
		frame[p.names.name("param_count")] = p.values.number(float64(len(args)))
		for i, value := range args {
			frame[p.names.name(fmt.Sprintf("param_%d", i+1))] = value
			if i < len(info.names) {
				frame[info.names[i]] = value
			}
		}
	}
	pending := []uint64{target}
	seen := make(map[uint64]bool)
	params := uint64(0)
	for len(pending) > 0 {
		id := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if seen[id] {
			continue
		}
		seen[id] = true
		doc, line := uint32(id>>32), uint32(id)
		d := p.Documents[doc]
		n := d.rowAt(int(line))
		c := p.names.Names[n.Command]
		switch c {
		case "script", "gosub", "gosub_scene", "goto_scene", "redirect_scene", "finish", "goto_random_scene":
			return nil
		case "params":
			if params != 0 && params != id {
				return nil
			}
			params = id
		case "create", "temp", "set", "setref", "rand", "input_text", "input_number", "delete":
			name := n.Target
			if c == "setref" || n.TargetExpr != 0 && d.Exprs[n.TargetExpr].Kind == exIndirect {
				expression := n.TargetExpr
				if c != "setref" {
					expression = d.Exprs[expression].A
				}
				resolved := p.frameAddress(d, expression, frame)
				if resolved == 0 {
					return nil
				}
				name = resolved
			}
			delete(frame, name)
			if n.TargetExpr != 0 && d.Exprs[n.TargetExpr].Kind == exArray {
				prefix := p.names.Names[d.Exprs[n.TargetExpr].Arg] + "_"
				for name := range frame {
					if strings.HasPrefix(p.names.Names[name], prefix) {
						delete(frame, name)
					}
				}
			}
		case "create_array", "temp_array", "delete_array":
			prefix := p.names.Names[n.Target] + "_"
			for name := range frame {
				if strings.HasPrefix(p.names.Names[name], prefix) {
					delete(frame, name)
				}
			}
		case "return", "ending", "abort", "restart":
			continue
		case "goto", "gotoref":
			next, _, _ := p.jump(d, n, 0, c)
			if uint32(next) == 0 {
				return nil
			}
			pending = append(pending, next)
			continue
		}
		for _, next := range p.graphs[doc].targets(line) {
			pending = append(pending, nodeID(doc, next))
		}
	}
	return frame
}
func (p *Project) frameAddress(d *Document, id uint32, frame map[uint32]Value) uint32 {
	v := evaluate(d, id, &p.names, &p.values, func(name uint32) Value {
		if value := frame[name]; value != 0 {
			return value
		}
		return UnknownType
	})
	if primitive, ok := p.values.constant(v); ok && Value(primitive.Kind) == StringType {
		return p.names.name(strings.ToLower(primitive.Text))
	}
	return 0
}
func (p *Project) effectMemberRead(e *callEffects, name, scope uint32) {
	spelling := p.names.Names[name]
	separator := strings.LastIndexByte(spelling, '_')
	if separator < 0 {
		return
	}
	tail := spelling[separator+1:]
	if tail == "" {
		return
	}
	for i := range tail {
		if tail[i] < '0' || tail[i] > '9' {
			return
		}
	}
	base := p.names.name(spelling[:separator])
	e.addArray(key{0, base}, false)
	e.addArray(key{scope, base}, false)
}
func (p *Project) inspectEffectExpression(d *Document, id uint32, frame map[uint32]Value, effects *callEffects) bool {
	if id == 0 {
		return true
	}
	e := d.Exprs[id]
	switch e.Kind {
	case exIndirect:
		if !p.inspectEffectExpression(d, e.A, frame, effects) {
			return false
		}
		name := p.frameAddress(d, e.A, frame)
		if name == 0 {
			return false
		}
		for _, scope := range []uint32{0, d.Scope} {
			effects.needed[p.names.key(scope, name)] = true
			effects.needed[p.names.key(scope, p.names.name(p.names.Names[name]+"_*"))] = true
		}
		p.effectMemberRead(effects, name, d.Scope)
	case exBinary:
		return p.inspectEffectExpression(d, e.A, frame, effects) && p.inspectEffectExpression(d, e.B, frame, effects)
	case exArray, exCall:
		for _, id := range d.Args[e.A : e.A+e.B] {
			if !p.inspectEffectExpression(d, id, frame, effects) {
				return false
			}
		}
	}
	return true
}
func (p *Project) inspectEffectRow(d *Document, line uint32, n row, frame map[uint32]Value, effects *callEffects) bool {
	if !p.inspectEffectExpression(d, n.Expr, frame, effects) {
		return false
	}
	for token := n.TokenStart; token < n.TokenStart+n.TokenCount; token++ {
		if !p.inspectEffectExpression(d, d.TokenExpr[token], frame, effects) {
			return false
		}
		if name := d.TokenName[token]; name != 0 {
			p.effectMemberRead(effects, name, d.Scope)
		}
	}
	for _, id := range d.Args[n.ExprStart : n.ExprStart+n.ExprCount] {
		if !p.inspectEffectExpression(d, id, frame, effects) {
			return false
		}
	}
	for _, id := range d.rowSubstitutions(line) {
		if !p.inspectEffectExpression(d, id, frame, effects) {
			return false
		}
	}
	return true
}
