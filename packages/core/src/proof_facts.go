package core

// Each observation summary retains all source rows, reference values and binding
// scopes. Values that are unchanged within a routine read their exact incoming
// binding; fixed/formal values use the routine's proven symbolic frame.
type proofFact struct {
	token, name uint32
	value       provedValue
	scope       uint32 // 0 means resolve against the actual entry environment.
}
type proofLine struct {
	line  uint32
	entry [14]uint8
	facts []proofFact
}

func (p *Project) proofFacts(d *Document, line uint32, frame proofFrame, args []Value, expressionValue provedValue) ([]proofFact, bool) {
	n := d.rowAt(int(line))
	c := p.names.Names[n.Command]
	var result []proofFact
	parameter := 0
	for token := n.TokenStart; token < n.TokenStart+n.TokenCount; token++ {
		t := d.Syntax[token]
		if t.Type != Variable {
			continue
		}
		name := d.TokenName[token]
		if name == 0 || d.TokenExpr[token] != 0 {
			return nil, false
		}
		fact := proofFact{token: token, name: name}
		if value, exists := frame[p.names.key(d.Scope, name)]; exists {
			if value.value == 0 && value.argument == 0 {
				return nil, false
			}
			fact.value = value
			fact.scope = d.Scope + 1
		} else if value, exists := frame[p.names.key(0, name)]; exists {
			if value.value == 0 && value.argument == 0 || !p.globalBinding(d.Scope, name) {
				return nil, false
			}
			fact.value = value
			fact.scope = 1
		}
		if t.Modifiers&declared != 0 && n.Expr != 0 {
			fact.value = expressionValue
			if fact.value.value == 0 && fact.value.argument == 0 {
				return nil, false
			}
		}
		if t.Modifiers&declared != 0 && c == "params" {
			parameter++
			fact.value = provedValue{value: UnknownType}
			if parameter <= len(args) {
				fact.value = provedValue{argument: parameter}
			}
		}
		result = append(result, fact)
	}
	return result, true
}
func (p *Project) observeProof(plan *returnProof, state flowState, args []Value) {
	slot := (state.quote - 1) * 2
	if state.paragraph {
		slot++
	}
	d := p.Documents[plan.doc]
	for _, line := range plan.lines {
		entry := line.entry[slot]
		old := p.observation(plan.doc, line.line)
		hadIncoming := old.quote != 0
		old.quote |= entry & 7
		// A zero old quote has no incoming path and therefore no paragraph fact.
		if !hadIncoming {
			old.paragraph = entry&8 != 0
		} else {
			old.paragraph = old.paragraph && entry&8 != 0
		}
		p.setObservation(plan.doc, line.line, old)
		for _, fact := range line.facts {
			value := fact.value.value
			scope := fact.scope
			if fact.value.argument != 0 {
				value = args[fact.value.argument-1]
			} else if value == 0 {
				value = p.lookup(state.env, d.Scope, fact.name)
			}
			if scope == 0 {
				scope = p.bindingScope(state.env, d.Scope, fact.name)
			}
			values := p.tokenValues[plan.doc]
			if values[fact.token] == 0 {
				values[fact.token] = value
			} else {
				values[fact.token] = p.values.join(values[fact.token], value)
			}
			scopes := p.tokenScopes[plan.doc]
			if scopes[fact.token] == 0 {
				scopes[fact.token] = scope
			} else if scopes[fact.token] != scope {
				scopes[fact.token] = mixedScope
			}
		}
	}
	plan.observed = true
}
