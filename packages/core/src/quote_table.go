package core

import (
	"strings"
	"unicode/utf8"
)

// Compile all fourteen quote/paragraph inputs in one source pass. This is exact
// only after every substitution on the row has been proved quote-free. Expression
// strings stay opaque; multireplace branches inherit their own paragraph state.
func quoteFreeTable(raw string) (uint64, bool) {
	var state [14]uint8
	for slot := range state {
		state[slot] = uint8(slot/2 + 1)
	}
	result, ok := quoteTextVector(raw, state, 0x2aaa, 0)
	if !ok {
		return 0, false
	}
	// The ordinary whole-row transfer deliberately keeps wholly unknown incoming
	// dialogue unknown. Replacement branches do not have this early return.
	result[12], result[13] = 7, 7
	var table uint64
	for slot, value := range result {
		table |= uint64(value) << (slot * 3)
	}
	return table, true
}
func quoteTextVector(raw string, state [14]uint8, paragraphs uint16, depth int) ([14]uint8, bool) {
	if depth > 64 {
		return state, false
	}
	first := true
	for i := 0; i < len(raw); {
		if kind, open, ok := substitution(raw, i); ok {
			closing := matching(raw, open)
			if closing < 0 {
				return state, false
			}
			if kind == '@' {
				body := raw[open+1 : closing]
				cut, nesting := -1, 0
				for j, ch := range body {
					if ch == '(' {
						nesting++
					}
					if ch == ')' {
						nesting--
					}
					if white(ch) && nesting == 0 {
						cut = j
						break
					}
				}
				if cut < 0 {
					return state, false
				}
				_, width := utf8.DecodeRuneInString(body[cut:])
				branchParagraphs := paragraphs
				if !first {
					branchParagraphs = 0
				}
				var joined [14]uint8
				for alternative := range strings.SplitSeq(body[cut+width:], "|") {
					branch, ok := quoteTextVector(alternative, state, branchParagraphs, depth+1)
					if !ok {
						return state, false
					}
					for slot, value := range branch {
						joined[slot] |= value
					}
				}
				state = joined
			}
			first = false
			i = closing + 1
			continue
		}
		if raw[i] == '[' {
			if closing := strings.IndexByte(raw[i+1:], ']'); closing >= 0 {
				i += closing + 2
				continue
			}
		}
		ch, width := utf8.DecodeRuneInString(raw[i:])
		quote := uint8(0)
		switch ch {
		case '"':
			quote = 1
		case '“':
			quote = 2
		case '”':
			quote = 3
		}
		if quote != 0 {
			for slot, value := range state {
				state[slot] = advanceQuote(value, quote, first && paragraphs&(1<<slot) != 0)
			}
			first = false
		} else if first && !white(ch) {
			first = false
		}
		i += width
	}
	return state, true
}
