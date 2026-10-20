package core

func (p *Project) runReads(d *Document, rows []uint32) (*callEffects, bool) {
	var result *callEffects
	whole := false
	add := func(name uint32) {
		if result == nil {
			result = &callEffects{needed: make(map[uint32]bool), noRegisters: true}
		}
		for _, scope := range []uint32{0, d.Scope} {
			result.needed[p.names.key(scope, name)] = true
			result.needed[p.names.key(scope, p.names.name(p.names.Names[name]+"_*"))] = true
		}
	}
	var arrays func(uint32)
	arrays = func(id uint32) {
		if id == 0 {
			return
		}
		e := d.Exprs[id]
		switch e.Kind {
		case exIndirect:
			whole = true
		case exArray:
			if result == nil {
				result = &callEffects{needed: make(map[uint32]bool), noRegisters: true}
			}
			for _, scope := range []uint32{0, d.Scope} {
				result.addArray(key{scope, e.Arg}, false)
			}
			for _, id := range d.Args[e.A : e.A+e.B] {
				arrays(id)
			}
		case exBinary:
			arrays(e.A)
			arrays(e.B)
		case exCall:
			for _, id := range d.Args[e.A : e.A+e.B] {
				arrays(id)
			}
		}
	}
	for _, line := range rows {
		n := d.rowAt(int(line))
		for token := n.TokenStart; token < n.TokenStart+n.TokenCount; token++ {
			if name := d.TokenName[token]; name != 0 {
				add(name)
				base := elementBase(p.names.Names[name])
				if base != p.names.Names[name] {
					add(p.names.name(base))
				}
			}
			arrays(d.TokenExpr[token])
		}
	}
	return result, whole
}
