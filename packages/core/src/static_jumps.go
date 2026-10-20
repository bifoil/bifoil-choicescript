package core

// Only literal destinations are specialized. Indirect references and gotoref
// keep resolving against every incoming environment. These facts belong to one
// complete project snapshot and are rebuilt after any edit or scene change.
type staticJump struct {
	target                 uint64
	sceneKnown, labelKnown bool
}

func (p *Project) prepareStaticJumps() {
	p.staticJumps = nil
	if p.disableStaticJumps {
		return
	}
	resolved := make(map[uint64]staticJump)
	for _, d := range p.Documents {
		for _, line := range d.semanticRows() {
			n := d.lexicalRow(int(line))
			c := p.names.Names[n.Command]
			count := 0
			switch c {
			case "goto", "gosub":
				count = 1
			case "goto_scene", "gosub_scene", "redirect_scene":
				count = 2
			default:
				continue
			}
			if n.ExprCount == 0 {
				continue
			}
			literal := true
			for _, id := range d.Args[n.ExprStart : n.ExprStart+min(n.ExprCount, uint32(count))] {
				if id == 0 || d.Exprs[id].Kind != exLiteral {
					literal = false
					break
				}
			}
			if literal {
				target, sceneKnown, labelKnown := p.jump(d, n, 0, c)
				resolved[uint64(d.Scope)<<32|uint64(n.ExprStart)] = staticJump{target, sceneKnown, labelKnown}
			}
		}
	}
	p.staticJumps = resolved
}
