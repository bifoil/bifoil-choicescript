package core

import (
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"
)

func (p *Project) renderedValue(state *flowState, value Value) {
	state.quote = applyQuoteEffect(p.values.quote(value), state.quote)
}
func quoteType(mask uint8) uint8 {
	if mask == 2 || mask == 4 {
		return Dialogue
	}
	return Narrative
}
func (p *Project) textTransfer(d *Document, line uint32, state *flowState, collect bool, start, limit uint32, replacement bool) []Token {
	return p.appendTextTransfer(nil, d, line, state, collect, start, limit, replacement)
}

// Pure narrative appends directly to completed output; other callers can still
// request an independent slice for syntax overlays and replacement alternatives.
func (p *Project) appendTextTransfer(spans []Token, d *Document, line uint32, state *flowState, collect bool, start, limit uint32, replacement bool) []Token {
	n := d.lexicalRow(int(line))
	mask := state.quote
	if !replacement {
		start = n.Indent
		if n.Kind == option {
			start++
		}
		if n.Inline != noOffset {
			start = units(d.raw(line)[:n.Inline])
		}
		limit = d.widthAt(line)
	}
	independent := n.Kind == option || n.Inline != noOffset
	if !replacement && independent {
		mask = 1
	}
	if !collect && !replacement {
		if independent {
			return nil
		}
		if mask == 7 {
			state.paragraph = false
			return nil
		}
	}
	if !collect && !replacement && n.Flags&2 != 0 {
		if !independent {
			state.quote = p.flowText(d, line, mask, state.paragraph)
			state.paragraph = false
		}
		return nil
	}
	run := start
	kind := quoteType(mask)
	emit := func(end uint32) {
		if collect && end > run {
			spans = append(spans, Token{Line: line - 1, Start: run, Length: end - run, Type: kind})
		}
	}
	if n.Flags&1 != 0 {
		if !collect {
			if !independent {
				state.quote = d.proseTransfer(line, mask, state.paragraph)
				state.paragraph = false
			}
			return nil
		}
		template := d.Templates[line]
		for _, mark := range d.QuoteMarks[template.Start : template.Start+template.Count] {
			if p.QuoteWarnings && mark.Kind == 3 && mask == 1 {
				d.Diagnostics = append(d.Diagnostics, diagnostic(line-1, mark.Column, 1, "quote-unexpected-close", "Closing curly dialogue quote has no opening quote on this path.", 2))
			}
			next := advanceQuote(mask, mark.Kind, state.paragraph && mark.First)
			before, after := quoteType(mask) == Dialogue, quoteType(next) == Dialogue
			if !before && after {
				emit(mark.Column)
				run = mark.Column
				kind = Dialogue
			} else if before && !after {
				emit(mark.Column + 1)
				run = mark.Column + 1
				kind = Narrative
			}
			mask = next
		}
	} else {
		raw := d.raw(line)
		begin, end := unitBytes(raw, start), unitBytes(raw, limit)
		column := start
		first := true
		for i := begin; i < end; {
			if substitutionKind, open, ok := substitution(raw, i); ok {
				close := matching(raw, open)
				if close < 0 || close >= end {
					break
				}
				emit(column)
				bodyColumn := column + uint32(open-i+1)
				if substitutionKind == '$' {
					branch := *state
					branch.quote = mask
					location := uint64(line-1)<<32 | uint64(bodyColumn)
					if int(d.Scope-1) >= len(p.fixedSubstitutions) || !p.fixedSubstitutions[d.Scope-1][location] {
						value := UnknownType
						if collect && !p.disableTokenFacts {
							if observed := p.interpolationValues[d.Scope-1][location]; observed != 0 {
								value = observed
							}
						} else {
							value = p.eval(d, d.Substitutions[location], state.env)
							if !p.disableTokenFacts && !collect {
								old := p.interpolationValues[d.Scope-1][location]
								if old == 0 {
									p.interpolationValues[d.Scope-1][location] = value
								} else {
									p.interpolationValues[d.Scope-1][location] = p.values.join(old, value)
								}
							}
						}
						p.renderedValue(&branch, value)
					}
					mask = branch.quote
				} else {
					body := raw[open+1 : close]
					cut, depth := -1, 0
					for j, ch := range body {
						if ch == '(' {
							depth++
						}
						if ch == ')' {
							depth--
						}
						if white(ch) && depth == 0 {
							cut = j
							break
						}
					}
					if cut < 0 {
						mask = 7
					} else {
						_, width := utf8.DecodeRuneInString(body[cut:])
						position := bodyColumn + units(body[:cut+width])
						union := uint8(0)
						for alternative := range strings.SplitSeq(body[cut+width:], "|") {
							branch := *state
							branch.quote = mask
							branch.paragraph = state.paragraph && first
							spans = append(spans, p.textTransfer(d, line, &branch, collect, position, position+units(alternative), true)...)
							union |= branch.quote
							position += units(alternative) + 1
						}
						mask = union
						if mask == 0 {
							mask = 7
						}
					}
				}
				column += units(raw[i : close+1])
				i = close + 1
				run = column
				kind = quoteType(mask)
				first = false
				continue
			}
			if raw[i] == '[' {
				if close := strings.IndexByte(raw[i+1:end], ']'); close >= 0 {
					length := close + 2
					column += units(raw[i : i+length])
					i += length
					continue
				}
			}
			ch, width := utf8.DecodeRuneInString(raw[i:end])
			quote := uint8(0)
			if ch == '"' {
				quote = 1
			}
			if ch == '“' {
				quote = 2
			}
			if ch == '”' {
				quote = 3
			}
			if quote == 0 {
				if !white(ch) {
					first = false
				}
			} else {
				if collect && p.QuoteWarnings && quote == 3 && mask == 1 {
					d.Diagnostics = append(d.Diagnostics, diagnostic(line-1, column, 1, "quote-unexpected-close", "Closing curly dialogue quote has no opening quote on this path.", 2))
				}
				next := advanceQuote(mask, quote, state.paragraph && first)
				before, after := quoteType(mask) == Dialogue, quoteType(next) == Dialogue
				if !before && after {
					emit(column)
					run = column
					kind = Dialogue
				} else if before && !after {
					emit(column + 1)
					run = column + 1
					kind = Narrative
				}
				mask = next
				first = false
			}
			i += width
			column++
			if ch > 0xffff {
				column++
			}
		}
	}
	emit(limit)
	if replacement || !independent {
		state.quote = mask
		state.paragraph = false
	}
	return spans
}

// A sweep emits disjoint UTF-16 intervals. Earlier syntax overlays have priority
// over later overlays and prose, including interpolations inside string literals.
func overlay(base, syntax []Token) []Token {
	if len(syntax) == 0 {
		return base
	}
	if len(base) == 0 {
		ordered := true
		for i := 1; i < len(syntax); i++ {
			if syntax[i-1].Start+syntax[i-1].Length > syntax[i].Start {
				ordered = false
				break
			}
		}
		if ordered {
			return syntax
		}
	}
	spans := append(append(make([]Token, 0, len(base)+len(syntax)), syntax...), base...)
	type event struct {
		at    uint32
		index int
		start bool
	}
	events := make([]event, 0, len(spans)*2)
	for index, span := range spans {
		if span.Length > 0 {
			events = append(events, event{span.Start, index, true}, event{span.Start + span.Length, index, false})
		}
	}
	sort.Slice(events, func(i, j int) bool { return events[i].at < events[j].at })
	active := make([]bool, len(spans))
	heap := make([]int, 0, len(spans))
	var result []Token
	for i := 0; i < len(events); {
		start := events[i].at
		for i < len(events) && events[i].at == start {
			e := events[i]
			active[e.index] = e.start
			if e.start {
				heap = append(heap, e.index)
				for k := len(heap) - 1; k > 0; {
					parent := (k - 1) / 2
					if heap[parent] <= e.index {
						break
					}
					heap[k] = heap[parent]
					k = parent
					heap[k] = e.index
				}
			}
			i++
		}
		for len(heap) > 0 && !active[heap[0]] {
			last := heap[len(heap)-1]
			heap = heap[:len(heap)-1]
			if len(heap) == 0 {
				break
			}
			heap[0] = last
			for k := 0; ; {
				child := k*2 + 1
				if child >= len(heap) {
					break
				}
				if child+1 < len(heap) && heap[child+1] < heap[child] {
					child++
				}
				if heap[child] >= last {
					break
				}
				heap[k] = heap[child]
				k = child
				heap[k] = last
			}
		}
		if i < len(events) && len(heap) > 0 && events[i].at > start {
			span := spans[heap[0]]
			span.Start = start
			span.Length = events[i].at - start
			result = append(result, span)
		}
	}
	return result
}

// Symbol IDs are numeric and analysis-local. Locations always retain the exact
// source URI so scene routing does not silently rewrite source identity.
type Symbol struct {
	Name, Kind string
	Location   Location
}

func (p *Project) declare(d *Document, line uint32, token uint32, kind string, name uint32, array ...bool) uint32 {
	t := &d.Syntax[token]
	id := uint32(len(p.Symbols))
	scope := d.Scope
	if kind == "global" {
		scope = 0
	}
	k := key{scope, name}
	index := p.symbols
	if len(array) > 0 && array[0] {
		index = p.arrayDeclarations
	}
	if kind == "label" {
		index = p.labelSymbols
	}
	previous, exists := index[k]
	if exists && kind != "local" {
		d.Diagnostics = append(d.Diagnostics, diagnostic(line-1, t.Start, t.Length, "duplicate-symbol", "Duplicate "+kind+" "+p.names.Names[name]+".", 1))
	}
	symbol := Symbol{p.names.Names[name], kind, Location{d.URI, Range{Position{line - 1, t.Start}, Position{line - 1, t.Start + t.Length}}}}
	if exists {
		id = previous
		p.Symbols[id] = symbol
	} else {
		p.Symbols = append(p.Symbols, symbol)
		p.SymbolValues = append(p.SymbolValues, 0)
	}
	index[k] = id
	t.Symbol = id
	return id
}
func (p *Project) render() {
	p.Tokens = make([][]Token, len(p.Documents))
	for index, d := range p.Documents {
		// This reserves capacity only. Every additional span is still appended,
		// including unusually dense markup and replacement alternatives.
		capacity := min(1_000_000, len(d.Syntax)+d.nonBlankRows+len(d.QuoteMarks))
		p.Tokens[index] = make([]Token, 0, capacity)
		d.ProseEntries = make([]uint8, d.RowCount())
		d.ProseEffects = nil
		for line := uint32(1); line < uint32(d.RowCount()); line++ {
			if d.rowKind(line) == blank {
				continue
			}
			n := d.lexicalRow(int(line))
			c := p.names.Names[n.Command]
			state := p.observation(uint32(index), line)
			if state.quote == 0 {
				state = flowState{quote: 7, paragraph: true}
			}
			if n.Flags&1 != 0 {
				d.ProseEntries[line] = state.quote
				if state.paragraph {
					d.ProseEntries[line] |= 8
				}
				if effect := d.Templates[line].Exit; effect != 0 {
					if d.ProseEffects == nil {
						d.ProseEffects = make([]uint64, d.RowCount())
					}
					d.ProseEffects[line] = effect
				}
			}
			var base []Token
			direct := !p.disableDirectRender && n.Kind == prose && n.Flags&1 != 0 && n.TokenCount == 0
			if direct {
				copy := state
				if d.Templates[line].Count == 0 {
					// The complete lexical scan proved this row has no quotation marks or
					// syntax islands. Its inherited quote state still comes from full flow.
					if end := d.widthAt(line); end > n.Indent {
						p.Tokens[index] = append(p.Tokens[index], Token{Line: line - 1, Start: n.Indent, Length: end - n.Indent, Type: quoteType(state.quote)})
					}
				} else {
					p.Tokens[index] = p.appendTextTransfer(p.Tokens[index], d, line, &copy, true, 0, 0, false)
				}
			} else if n.Kind == prose || n.Kind == option || n.Inline != noOffset {
				copy := state
				base = p.textTransfer(d, line, &copy, true, 0, 0, false)
			}
			if p.QuoteWarnings && state.quote != 7 && state.quote&(state.quote-1) != 0 && n.Kind == prose {
				length := d.widthAt(line) - n.Indent
				if length == 0 {
					length = 1
				}
				d.Diagnostics = append(d.Diagnostics, diagnostic(line-1, n.Indent, length, "quote-branch", "Incoming paths disagree about whether dialogue is open.", 2))
			}
			if direct {
				continue
			}
			syntax := make([]Token, n.TokenCount)
			copy(syntax, d.Syntax[n.TokenStart:n.TokenStart+n.TokenCount])
			parameter := 0
			for offset := range syntax {
				t := &syntax[offset]
				id := n.TokenStart + uint32(offset)
				if t.Type == Variable && !p.disableTokenFacts {
					p.renderVariable(d, line, id, t)
				} else if t.Type == Variable {
					name := d.TokenName[id]
					scope := p.variableScope(d, id, state.env)
					symbol := p.variableSymbol(d, *t, id, scope)
					if symbol != 0 && p.arraySymbols[symbol] && p.Symbols[symbol].Name != p.names.Names[name] {
						t.ReferenceLength = uint32(len(p.Symbols[symbol].Name))
					}
					t.Symbol = symbol
					value := p.lookup(state.env, d.Scope, name)
					if c == "params" && t.Modifiers&declared != 0 {
						value = p.arena.get(state.env, p.names.key(parameterScope, p.names.name(fmt.Sprint(parameter))))
						parameter++
						if value == 0 {
							value = UnknownType
						}
					}
					if c == "temp" && t.Modifiers&declared != 0 && n.Expr == 0 {
						value = UnknownType
					}
					if t.Modifiers&declared != 0 && n.Expr != 0 {
						value = p.eval(d, n.Expr, state.env)
					}
					if expression := d.TokenExpr[id]; expression != 0 {
						value = p.eval(d, expression, state.env)
					}
					switch value & 15 {
					case StringType:
						t.Type = StringVariable
					case NumberType:
						t.Type = NumberVariable
					case BoolType:
						t.Type = BooleanVariable
					}
					if symbol != 0 {
						prior := p.SymbolValues[symbol]
						if prior == 0 || t.Modifiers&declared != 0 && n.Expr != 0 {
							p.SymbolValues[symbol] = value
						} else {
							p.SymbolValues[symbol] = p.values.join(prior, value)
						}
					}
				} else if t.Type == Label && t.Symbol == 0 {
					raw := d.raw(line)
					spelling := raw[unitBytes(raw, t.Start):unitBytes(raw, t.Start+t.Length)]
					parent := ""
					if n.Parent != 0 {
						parent = p.names.Names[d.lexicalRow(int(n.Parent)).Command]
					}
					if parent == "scene_list" || parent == "goto_random_scene" || strings.HasSuffix(c, "_scene") && id == n.TargetToken {
						if dest, ok := p.scenes[spelling]; ok {
							t.Symbol = p.SceneSymbols[dest]
						}
					} else {
						scope := d.Scope
						if strings.HasSuffix(c, "_scene") {
							target, _, _ := p.jump(d, n, state.env, c)
							if !p.disableTokenFacts {
								observed := p.tokenScopes[index][id]
								if observed != 0 && observed != mixedScope {
									t.Symbol = observed
								}
								scope = 0
							} else if uint32(target) != 0 {
								scope = p.Documents[uint32(target>>32)].Scope
							} else {
								scope = 0
							}
						}
						if t.Symbol == 0 {
							t.Symbol = p.labelSymbols[key{scope, p.names.name(strings.ToLower(spelling))}]
						}
					}
				}
			}
			if n.TargetToken != 0 && (c == "goto" || c == "gosub" || strings.HasSuffix(c, "_scene")) && d.Syntax[n.TargetToken].Type == Label {
				found := false
				if strings.HasSuffix(c, "_scene") {
					_, found = p.scenes[p.names.Names[n.Target]]
				} else {
					_, found = p.labels[key{d.Scope, n.Target}]
				}
				if !found {
					t := d.Syntax[n.TargetToken]
					what := "label"
					if strings.HasSuffix(c, "_scene") {
						what = "scene"
					}
					d.Diagnostics = append(d.Diagnostics, diagnostic(line-1, t.Start, t.Length, "missing-target", "Unknown "+what+" "+p.names.Names[n.Target]+".", 1))
				}
			}
			spans := overlay(base, syntax)
			var styles uint8
			for _, span := range spans {
				if span.Type == Markup {
					if span.Modifiers&16 != 0 {
						styles |= bold
					}
					if span.Modifiers&32 != 0 {
						styles &^= bold
					}
					if span.Modifiers&64 != 0 {
						styles |= italic
					}
					if span.Modifiers&128 != 0 {
						styles &^= italic
					}
				} else {
					span.Modifiers |= styles
				}
				span.Modifiers &= 15
				p.Tokens[index] = append(p.Tokens[index], span)
			}
		}
	}
	if p.QuoteWarnings && len(p.Documents) > 0 {
		for context, state := range p.summaries {
			doc, root := p.rootContexts[uint32(context)]
			if !root || state.quote != 2 && state.quote != 4 {
				continue
			}
			d := p.Documents[doc]
			for line := uint32(d.RowCount() - 1); line > 0; line-- {
				if d.lexicalRow(int(line)).Kind == prose {
					start := d.lexicalRow(int(line)).Indent
					length := d.widthAt(line) - start
					if length == 0 {
						length = 1
					}
					d.Diagnostics = append(d.Diagnostics, diagnostic(line-1, start, length, "quote-unclosed", "Dialogue is still open at the end of a resolved story path.", 2))
					break
				}
			}
		}
	}
}
