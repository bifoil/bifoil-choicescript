package core

// Seven three-bit outputs encode the complete quotation effect for every input
// mask. This property survives joins of different strings, even when their exact
// spelling is no longer known. Numbers and booleans cannot emit quote characters.
const unknownQuoteEffect uint32 = 1<<21 - 1

var identityQuoteEffect = func() uint32 {
	var result uint32
	for q := uint8(1); q <= 7; q++ {
		result |= uint32(q) << ((q - 1) * 3)
	}
	return result
}()

func applyQuoteEffect(effect uint32, quote uint8) uint8 {
	return uint8(effect >> ((quote - 1) * 3) & 7)
}
func literalQuoteEffect(text string) uint32 {
	result := identityQuoteEffect
	for _, ch := range text {
		kind := uint8(0)
		if ch == '"' {
			kind = 1
		}
		if ch == '“' {
			kind = 2
		}
		if ch == '”' {
			kind = 3
		}
		if kind == 0 {
			continue
		}
		var next uint32
		for q := uint8(1); q <= 7; q++ {
			next |= uint32(advanceQuote(applyQuoteEffect(result, q), kind, false)) << ((q - 1) * 3)
		}
		result = next
	}
	return result
}
func composeQuoteEffects(left, right uint32) uint32 {
	var result uint32
	for q := uint8(1); q <= 7; q++ {
		result |= uint32(applyQuoteEffect(right, applyQuoteEffect(left, q))) << ((q - 1) * 3)
	}
	return result
}
func (p *valuePool) quote(value Value) uint32 {
	if value == 0 || value&(UnknownType|bindingPresence) != 0 {
		return unknownQuoteEffect
	}
	if value&StringType == 0 {
		return identityQuoteEffect
	}
	if id := uint32(value) >> 4; id != 0 {
		return p.entries[id].Quote
	}
	return unknownQuoteEffect
}
func (p *valuePool) abstract(value Value, effect uint32) Value {
	mask := value & 15
	if mask&StringType == 0 || mask&UnknownType != 0 || effect == unknownQuoteEffect {
		return mask
	}
	return p.literal(primitive{Kind: uint8(mask), Abstract: true, Quote: effect})
}
func (p *valuePool) join(a, b Value) Value {
	if a == b {
		return a
	}
	if _, ok := p.arrayRanges(a); ok {
		return p.joinArrayRanges(a, b)
	}
	if _, ok := p.arrayRanges(b); ok {
		return p.joinArrayRanges(a, b)
	}
	if a&bindingPresence != 0 {
		a = a&15 | UnknownType
	}
	if b&bindingPresence != 0 {
		b = b&15 | UnknownType
	}
	result := joinValue(a, b)
	if a == b || result>>4 != 0 || result&(StringType|UnknownType) != StringType {
		return result
	}
	return p.abstract(result, p.quote(a)|p.quote(b))
}
