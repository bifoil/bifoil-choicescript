package core

import "fmt"

// Preserve primitive spelling/number only where it can select a name, array
// element or argument. All bindings still retain full type sets and quotation
// transfer functions, including values read indirectly or rendered as dialogue.
func (p *Project) prepareConstants() {
	p.constantNames = make(map[uint32]bool)
	p.allConstants = false
	dependencies := make(map[uint32][]uint32)
	indirectResults := make(map[uint32]bool)
	var dynamicWrites []uint32
	dynamicReads := false
	for _, d := range p.Documents {
		var inspect func(uint32, bool)
		inspect = func(id uint32, exact bool) {
			if id == 0 {
				return
			}
			e := d.Exprs[id]
			switch e.Kind {
			case exVariable:
				if exact {
					p.constantNames[e.Arg] = true
				}
			case exIndirect:
				inspect(e.A, true)
				if exact {
					p.allConstants = true
				}
			case exArray:
				if exact {
					p.constantNames[e.Arg] = true
				}
				for _, id := range d.Args[e.A : e.A+e.B] {
					inspect(id, true)
				}
			case exBinary:
				inspect(e.A, exact)
				inspect(e.B, exact)
			case exCall:
				for _, id := range d.Args[e.A : e.A+e.B] {
					inspect(id, exact)
				}
			}
		}
		for _, id := range d.Substitutions {
			inspect(id, false)
		}
		for _, line := range d.semanticRows() {
			n := d.rowAt(int(line))
			c := p.names.Names[n.Command]
			var used []uint32
			for id := n.TokenStart; id < n.TokenStart+n.TokenCount; id++ {
				if name := d.TokenName[id]; name != 0 {
					used = append(used, name)
				}
				inspect(d.TokenExpr[id], false)
			}
			inspect(n.Expr, false)
			if n.TargetExpr != 0 {
				e := d.Exprs[n.TargetExpr]
				if c == "setref" {
					inspect(n.TargetExpr, true)
				} else if e.Kind == exIndirect {
					inspect(e.A, true)
				} else {
					inspect(n.TargetExpr, false)
				}
			}
			if c == "goto" || c == "gosub" || c == "goto_scene" || c == "gosub_scene" || c == "redirect_scene" || c == "gotoref" {
				refs := d.Args[n.ExprStart : n.ExprStart+n.ExprCount]
				count := 1
				if c == "goto_scene" || c == "gosub_scene" || c == "redirect_scene" {
					count = min(2, len(refs))
				}
				target, _, _ := p.jump(d, n, 0, c)
				info := parameterInfo{}
				if uint32(target) != 0 {
					info = p.callParameters(target)
				}
				call := c == "gosub" || c == "gosub_scene"
				for i, id := range refs {
					e := d.Exprs[id]
					if i < count {
						if c != "gotoref" && e.Kind == exIndirect {
							inspect(e.A, true)
						} else {
							inspect(id, true)
						}
					} else if !call || !info.known {
						inspect(id, true)
					} else {
						inspect(id, false)
						names := expressionNames(d, id)
						alias := p.names.name(fmt.Sprintf("param_%d", i-count+1))
						dependencies[alias] = append(dependencies[alias], names...)
						indirectResults[alias] = indirectResults[alias] || expressionHasIndirect(d, id)
						if i-count < len(info.names) {
							parameter := info.names[i-count]
							dependencies[parameter] = append(dependencies[parameter], names...)
							indirectResults[parameter] = indirectResults[parameter] || expressionHasIndirect(d, id)
						}
					}
				}
			}
			if c == "create_array" || c == "temp_array" {
				if n.ExprCount > 0 {
					inspect(d.Args[n.ExprStart], true)
				}
			}
			if n.Target != 0 && (declarationCommands[c] || c == "set" || c == "setref" || c == "rand" || c == "input_text" || c == "input_number") {
				target := n.Target
				dynamic := c == "setref"
				if n.TargetExpr != 0 {
					e := d.Exprs[n.TargetExpr]
					if e.Kind == exVariable || e.Kind == exArray {
						target = e.Arg
					} else if e.Kind == exIndirect {
						dynamic = true
					}
				}
				hasIndirect := expressionHasIndirect(d, n.Expr)
				if dynamic {
					dynamicWrites = append(dynamicWrites, used...)
					dynamicReads = dynamicReads || hasIndirect
				} else {
					dependencies[target] = append(dependencies[target], used...)
					indirectResults[target] = indirectResults[target] || hasIndirect
				}
			}
		}
	}
	if p.allConstants {
		return
	}
	if len(p.constantNames) > 0 {
		for _, name := range dynamicWrites {
			p.constantNames[name] = true
		}
		if dynamicReads {
			p.allConstants = true
			return
		}
	}
	pending := make([]uint32, 0, len(p.constantNames))
	for name := range p.constantNames {
		pending = append(pending, name)
	}
	for len(pending) > 0 {
		name := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if indirectResults[name] {
			p.allConstants = true
			return
		}
		for _, use := range dependencies[name] {
			if !p.constantNames[use] {
				p.constantNames[use] = true
				pending = append(pending, use)
			}
		}
		base := elementBase(p.names.Names[name])
		if base != p.names.Names[name] {
			id := p.names.name(base)
			if !p.constantNames[id] {
				p.constantNames[id] = true
				pending = append(pending, id)
			}
		}
	}
}
func expressionHasIndirect(d *Document, id uint32) bool {
	if id == 0 {
		return false
	}
	e := d.Exprs[id]
	switch e.Kind {
	case exIndirect:
		return true
	case exBinary:
		return expressionHasIndirect(d, e.A) || expressionHasIndirect(d, e.B)
	case exArray, exCall:
		for _, id := range d.Args[e.A : e.A+e.B] {
			if expressionHasIndirect(d, id) {
				return true
			}
		}
	}
	return false
}
func (p *Project) bindingValue(name uint32, value Value) Value {
	if p.allConstants || p.constantNames[name] {
		return value
	}
	base := elementBase(p.names.Names[name])
	if base != p.names.Names[name] {
		if id, ok := p.names.names[base]; ok && p.constantNames[id] {
			return value
		}
	}
	return p.values.abstract(value, p.values.quote(value))
}
