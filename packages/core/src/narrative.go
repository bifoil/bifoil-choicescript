package core

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

type quoteMark struct {
	Column uint32
	Kind   uint8
	First  bool
}
type textTemplate struct {
	Exit         uint64
	Start, Count uint32
}

// Quote masks are outside=1, straight=2, curly=4. Unknown=7 is absorbing.
// Expression delimiters never enter this transfer; only rendered punctuation does.
func advanceQuote(mask uint8, kind uint8, continued bool) uint8 {
	if mask == 7 {
		return 7
	}
	switch kind {
	case 1:
		next := mask & 4
		if mask&1 != 0 {
			next |= 2
		}
		if mask&2 != 0 {
			if continued {
				next |= 2
			} else {
				next |= 1
			}
		}
		return next
	case 2:
		next := mask & 6
		if mask&1 != 0 {
			next |= 4
		}
		return next
	case 3:
		next := mask & 3
		if mask&4 != 0 {
			next |= 1
		}
		return next
	default:
		return mask
	}
}

func wordCharacter(r rune) bool {
	if r < 128 {
		return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9'
	}
	return unicode.IsLetter(r) || unicode.IsNumber(r)
}
func letter(r rune) bool {
	if r < 128 {
		return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z'
	}
	return unicode.IsLetter(r)
}

// Count authoring words without allocating a slice/string for every word.
// Complete bracket tags are excluded, matching the existing word-count contract.
func countWords(text string) uint32 {
	var words uint32
	inside := false
	for i := 0; i < len(text); {
		if text[i] == '[' {
			if closing := strings.IndexByte(text[i+1:], ']'); closing >= 0 {
				i += closing + 2
				continue
			}
		}
		r, width := utf8.DecodeRuneInString(text[i:])
		if wordCharacter(r) {
			if !inside {
				words++
				inside = true
			}
		} else if (r == '\'' || r == '’') && inside && i+width < len(text) {
			next, _ := utf8.DecodeRuneInString(text[i+width:])
			if !letter(next) {
				inside = false
			}
		} else {
			inside = false
		}
		i += width
	}
	return words
}

func (d *Document) proseTransfer(line uint32, quote uint8, paragraph bool) uint8 {
	template, has := d.Templates[line]
	if !has {
		return quote
	}
	row := (quote - 1) * 2
	if paragraph {
		row++
	}
	return uint8((template.Exit >> (row * 3)) & 7)
}

// Compact a completed lexical row before reading the next source line.
func (d *Document) compactRow(line uint32, raw string) {
	node := d.rowAt(int(line))
	start := int(node.IndentBytes)
	if node.Kind == option {
		start++
	}
	if node.Inline != noOffset {
		start = int(node.Inline)
	}
	pure := node.Kind == prose || node.Kind == option
	for index := node.TokenStart; index < node.TokenStart+node.TokenCount; index++ {
		token := &d.Syntax[index]
		if token.Type == Interpolation || token.Type == Variable {
			pure = false
		}
	}
	if !pure {
		// Finish the header after mutable command/metadata parsing. Scalar
		// predicates can then read it without rebuilding a full command row.
		d.setRow(int(line), node)
		d.Widths[line] = units(raw)
		if node.Kind == prose || node.Kind == option || node.Inline != noOffset {
			d.WordCounts[line] = countWords(raw[start:])
		}
		if node.Kind != blank {
			d.RawRows[line] = strings.Clone(raw)
		}
		return
	}
	d.markPureText(line)
	markStart := uint32(len(d.QuoteMarks))
	d.WordCounts[line], d.Widths[line] = d.summarizeProse(raw, start)
	if uint32(len(d.QuoteMarks)) == markStart {
		return
	}
	template := textTemplate{Start: markStart, Count: uint32(len(d.QuoteMarks)) - markStart}
	for mask := uint8(1); mask <= 7; mask++ {
		for paragraph := range 2 {
			quote := mask
			for _, mark := range d.QuoteMarks[template.Start : template.Start+template.Count] {
				quote = advanceQuote(quote, mark.Kind, paragraph == 1 && mark.First)
			}
			row := (mask-1)*2 + uint8(paragraph)
			template.Exit |= uint64(quote) << (row * 3)
		}
	}
	d.Templates[line] = template
}

// Collect all prose-only information in one source pass. The ASCII path avoids
// decoding ordinary narrative repeatedly; Unicode and bracket tags retain the
// same word, UTF-16 and quotation rules as command-bearing narrative.
func (d *Document) summarizeProse(raw string, start int) (words, width uint32) {
	width = units(raw[:start])
	inside, first := false, true
	for i := start; i < len(raw); {
		if used, starts, last := asciiWordRun(raw[i:], inside); used != 0 {
			words += starts
			inside = last
			width += uint32(used)
			if first {
				for _, b := range raw[i : i+used] {
					if !white(b) {
						first = false
						break
					}
				}
			}
			i += used
			continue
		}
		if raw[i] == '[' {
			if closing := strings.IndexByte(raw[i+1:], ']'); closing >= 0 {
				end := i + closing + 2
				width += units(raw[i:end])
				i = end
				continue
			}
		}
		if proseASCII[raw[i]] == 1 {
			begin := i
			for i < len(raw) && proseASCII[raw[i]] == 1 {
				i++
			}
			if !inside {
				words++
			}
			inside = true
			first = false
			width += uint32(i - begin)
			continue
		}
		if raw[i] == ' ' || raw[i] == '\t' {
			begin := i
			for i < len(raw) && (raw[i] == ' ' || raw[i] == '\t') {
				i++
			}
			inside = false
			width += uint32(i - begin)
			continue
		}
		r, size := rune(raw[i]), 1
		if raw[i] >= utf8.RuneSelf {
			r, size = utf8.DecodeRuneInString(raw[i:])
		}
		word := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9'
		if r >= 128 {
			word = wordCharacter(r)
		}
		if word {
			if !inside {
				words++
				inside = true
			}
		} else if (r == '\'' || r == '’') && inside && i+size < len(raw) {
			next := rune(raw[i+size])
			if next >= utf8.RuneSelf {
				next, _ = utf8.DecodeRuneInString(raw[i+size:])
			}
			if !letter(next) {
				inside = false
			}
		} else {
			inside = false
		}
		kind := uint8(0)
		switch r {
		case '"':
			kind = 1
		case '“':
			kind = 2
		case '”':
			kind = 3
		}
		if kind != 0 {
			d.QuoteMarks = append(d.QuoteMarks, quoteMark{Column: width, Kind: kind, First: first})
			first = false
		} else if first && !white(r) {
			first = false
		}
		i += size
		width++
		if r > 0xffff {
			width++
		}
	}
	return
}

var proseASCII = func() [256]uint8 {
	var classes [256]uint8
	for i := range 128 {
		if i >= 'a' && i <= 'z' || i >= 'A' && i <= 'Z' || i >= '0' && i <= '9' {
			classes[i] = 1
		}
	}
	return classes
}()
