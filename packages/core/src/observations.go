package core

// Reference values and scopes have their own fact arenas. Completed line
// observations therefore need only the three-bit quote mask and paragraph bit.
// The dense environment-bearing form remains available to the reference path.
func (p *Project) observation(doc uint32, line uint32) flowState {
	if p.disableTokenFacts {
		return p.observed[doc][line]
	}
	encoded := p.observedQuotes[doc][line]
	return flowState{quote: encoded & 7, paragraph: encoded&8 != 0}
}
func (p *Project) setObservation(doc uint32, line uint32, state flowState) {
	if p.disableTokenFacts {
		p.observed[doc][line] = state
		return
	}
	encoded := state.quote
	if state.paragraph {
		encoded |= 8
	}
	p.observedQuotes[doc][line] = encoded
}
func (p *Project) observe(doc uint32, line uint32, state flowState) {
	previous := p.observation(doc, line)
	if p.disableTokenFacts {
		p.setObservation(doc, line, p.merge(previous, state))
		return
	}
	if previous.quote == 0 {
		p.setObservation(doc, line, state)
		return
	}
	p.setObservation(doc, line, flowState{quote: previous.quote | state.quote, paragraph: previous.paragraph && state.paragraph})
}
func (p *Project) hasObservation(doc uint32) bool {
	if p.disableTokenFacts {
		for _, state := range p.observed[doc] {
			if state.quote != 0 {
				return true
			}
		}
	} else {
		for _, encoded := range p.observedQuotes[doc] {
			if encoded&7 != 0 {
				return true
			}
		}
	}
	return false
}
