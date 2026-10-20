package core

import (
	"reflect"
	"strings"
	"unicode/utf8"
)

type proseEvent struct {
	kind  byte
	first bool
	text  string
}

// Compare the rendered structure while ignoring ordinary prose. Expression
// strings remain opaque code. Multireplace alternatives retain their independent
// paragraph-entry state, including repeated opening quotation conventions.
func proseEvents(raw string, allowFirst bool) []proseEvent {
	result := []proseEvent{}
	first := true
	for i := 0; i < len(raw); {
		if kind, open, ok := substitution(raw, i); ok {
			close := matching(raw, open)
			if close < 0 {
				return append(result, proseEvent{kind: '!', text: raw[i:]})
			}
			body := raw[open+1 : close]
			if kind == '$' {
				result = append(result, proseEvent{kind: '$', text: body})
			} else {
				cut, depth := -1, 0
				for j, r := range body {
					if r == '(' {
						depth++
					}
					if r == ')' {
						depth--
					}
					if white(r) && depth == 0 {
						cut = j
						break
					}
				}
				if cut < 0 {
					result = append(result, proseEvent{kind: '!', text: body})
				} else {
					result = append(result, proseEvent{kind: '@', first: allowFirst && first, text: body[:cut]})
					_, width := utf8.DecodeRuneInString(body[cut:])
					for alternative := range strings.SplitSeq(body[cut+width:], "|") {
						result = append(result, proseEvent{kind: '|'})
						result = append(result, proseEvents(alternative, allowFirst && first)...)
					}
					result = append(result, proseEvent{kind: '}'})
				}
			}
			first = false
			i = close + 1
			continue
		}
		if raw[i] == '[' {
			if close := strings.IndexByte(raw[i+1:], ']'); close >= 0 {
				end := i + close + 2
				result = append(result, proseEvent{kind: '[', text: raw[i:end]})
				i = end
				continue
			}
		}
		r, width := utf8.DecodeRuneInString(raw[i:])
		kind := byte(0)
		switch r {
		case '"':
			kind = 1
		case '“':
			kind = 2
		case '”':
			kind = 3
		}
		if kind != 0 {
			result = append(result, proseEvent{kind: kind, first: allowFirst && first})
			first = false
		} else if !white(r) {
			first = false
		}
		i += width
	}
	return result
}
func sameSyntaxText(old *Document, line uint32, before string, parsed *Document, after string) bool {
	n := old.node(line + 1)
	m := parsed.rowAt(1)
	if n.TokenCount != m.TokenCount {
		return false
	}
	for i := uint32(0); i < n.TokenCount; i++ {
		a, b := old.Syntax[n.TokenStart+i], parsed.Syntax[m.TokenStart+i]
		if a.Type != b.Type || a.Modifiers != b.Modifiers {
			return false
		}
		left := before[unitBytes(before, a.Start):unitBytes(before, a.Start+a.Length)]
		right := after[unitBytes(after, b.Start):unitBytes(after, b.Start+b.Length)]
		if left != right {
			return false
		}
	}
	return true
}
func proseBody(raw string, n row) string {
	start := int(n.IndentBytes)
	if n.Kind == option {
		start++
	}
	if n.Inline != noOffset {
		start = int(n.Inline)
	}
	if start > len(raw) {
		return ""
	}
	return raw[start:]
}

// PatchNarrativeSpan preserves a completed project when an edit touches only
// prose inside one classified span. Relexing proves every code/markup island
// unchanged; event comparison proves all quote transfers unchanged. No variable,
// call, branch or scene analysis is discarded or replaced by a placeholder.
func (p *Project) PatchNarrativeSpan(doc, line uint32, before, after string, version int32) (*Project, bool) {
	if int(doc) >= len(p.Documents) || strings.ContainsAny(after, "\r\n") {
		return nil, false
	}
	old := p.Documents[doc]
	rowIndex := line + 1
	if int(rowIndex) >= old.widthCount() {
		return nil, false
	}
	n := old.node(rowIndex)
	if n.Kind != prose && n.Kind != option && n.Inline == noOffset {
		return nil, false
	}
	prefix := 0
	for prefix < len(before) && prefix < len(after) && before[prefix] == after[prefix] {
		prefix++
	}
	for prefix > 0 && prefix < len(before) && !utf8.RuneStart(before[prefix]) {
		prefix--
	}
	left, right := len(before), len(after)
	for left > prefix && right > prefix && before[left-1] == after[right-1] {
		left--
		right--
	}
	for left < len(before) && !utf8.RuneStart(before[left]) {
		left++
	}
	for right < len(after) && !utf8.RuneStart(after[right]) {
		right++
	}
	if strings.ContainsAny(before[prefix:left]+after[prefix:right], "\"“”$@[]{}*#|") {
		return nil, false
	}
	start, end := units(before[:prefix]), units(before[:left])
	token := p.TokenAt(doc, Position{line, start})
	if (token == nil || token.Type != Narrative && token.Type != Dialogue) && start > 0 && start == end {
		token = p.TokenAt(doc, Position{line, start - 1})
	}
	if token == nil || token.Type != Narrative && token.Type != Dialogue || start < token.Start || end > token.Start+token.Length {
		return nil, false
	}
	var names registry
	var values valuePool
	parsed := parseSource(Source{URI: old.URI, Text: after, Version: version}, old.Scope, &names, &values)
	if parsed.RowCount() != 2 || parsed.rowAt(1).Kind != n.Kind || parsed.rowAt(1).Indent != n.Indent || !sameSyntaxText(old, line, before, parsed, after) || !reflect.DeepEqual(proseEvents(proseBody(before, n), true), proseEvents(proseBody(after, parsed.rowAt(1)), true)) {
		return nil, false
	}
	delta := int64(units(after)) - int64(old.widthAt(rowIndex))
	q := *p
	q.Documents = append([]*Document(nil), p.Documents...)
	changed := *old
	changed.Version = version
	changed.updateLineMetrics(rowIndex, parsed.widthAt(1), parsed.wordAt(1))
	changed.Syntax = append([]Token(nil), old.Syntax...)
	for i := uint32(0); i < n.TokenCount; i++ {
		id := n.TokenStart + i
		source := parsed.Syntax[parsed.rowAt(1).TokenStart+i]
		changed.Syntax[id].Start = source.Start
		changed.Syntax[id].Length = source.Length
	}
	changed.Diagnostics = append([]Diagnostic(nil), old.Diagnostics...)
	shift := func(position Position) Position {
		if position.Line == line && position.Character >= end {
			position.Character = uint32(int64(position.Character) + delta)
		}
		return position
	}
	for i := range changed.Diagnostics {
		d := &changed.Diagnostics[i]
		if (d.Code == "quote-branch" || d.Code == "quote-unclosed") && d.Range.Start.Line == line {
			d.Range.Start.Character = n.Indent
			d.Range.End.Character = parsed.widthAt(1)
			continue
		}
		d.Range.Start = shift(d.Range.Start)
		if d.Range.End.Line == line && d.Range.End.Character > end {
			d.Range.End.Character = uint32(int64(d.Range.End.Character) + delta)
		}
	}

	q.Documents[doc] = &changed
	first, last := p.tokenLineBounds(doc, line)
	sequence := p.TokenSequence(doc)
	tokens := make([]Token, 0, last-first)
	for index := first; index < last; index++ {
		t := sequence.At(index)
		if t.Line == line {
			if t.Start == token.Start && t.Length == token.Length {
				t.Length = uint32(int64(t.Length) + delta)
			} else if t.Start >= end {
				t.Start = uint32(int64(t.Start) + delta)
			}
		}
		if t.Length != 0 {
			tokens = append(tokens, t)
		}
	}
	if !p.replaceQueryTokens(&q, doc, first, last, tokens) {
		return nil, false
	}
	return &q, true
}
