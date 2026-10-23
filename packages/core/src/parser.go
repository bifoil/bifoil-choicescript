package core

import (
	"bytes"
	"errors"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"
	"unsafe"
)

var blockCommands = map[string]bool{"if": true, "elseif": true, "elsif": true, "else": true, "choice": true, "fake_choice": true, "scene_list": true, "stat_chart": true, "achievement": true, "goto_random_scene": true}
var metadataCommands = map[string]bool{"scene_list": true, "stat_chart": true, "achievement": true, "goto_random_scene": true}
var declarationCommands = map[string]bool{"create": true, "temp": true, "create_array": true, "temp_array": true}
var expressionCommands = map[string]bool{"if": true, "elseif": true, "elsif": true, "selectable_if": true, "print": true, "looplimit": true}
var transferCommands = map[string]bool{"goto": true, "goto_scene": true, "redirect_scene": true, "gotoref": true, "finish": true, "ending": true, "return": true, "abort": true, "restart": true}
var markupPattern = regexp.MustCompile(`(?i)^\[/?(?:b|i|u|s|url|n|c)(?:=[^]]*)?/?]`)
var chartPattern = regexp.MustCompile(`^(percent|opposed_pair|text)\s+(\w+)`)
var randomCondition = regexp.MustCompile(`\*if\s+\((.*)\)\s+\S+\s*$`)

func trim(s string) string {
	start, _ := leading(s)
	end := len(s)
	for end > start {
		r, n := utf8.DecodeLastRuneInString(s[start:end])
		if !white(r) {
			break
		}
		end -= n
	}
	return s[start:end]
}
func matching(text string, start int) int {
	depth := 1
	for i := start + 1; i < len(text); i++ {
		if text[i] == '{' {
			depth++
		}
		if text[i] == '}' {
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}
func substitution(text string, start int) (kind byte, open int, ok bool) {
	if start >= len(text) || (text[start] != '$' && text[start] != '@') {
		return 0, 0, false
	}
	i := start + 1
	for count := 0; count < 2 && i < len(text) && text[i] == '!'; count++ {
		i++
	}
	return text[start], i, i < len(text) && text[i] == '{'
}
func (p *parser) narrative(text string, line, offset uint32) {
	if strings.IndexByte(text, '$') < 0 && strings.IndexByte(text, '@') < 0 && strings.IndexByte(text, '[') < 0 {
		p.poll()
		return
	}
	column := offset
	nextCheck := 0
	for i := 0; i < len(text); {
		if i >= nextCheck {
			p.poll()
			nextCheck = i + 4096
		}
		kind, open, found := substitution(text, i)
		if found {
			closing := matching(text, open)
			startColumn := column
			if closing < 0 {
				p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, startColumn, units(text[i:]), "interpolation-close", "Substitution must close on this line.", 1))
				p.doc.Syntax = append(p.doc.Syntax, Token{Line: line, Start: startColumn, Length: units(text[i:]), Type: Interpolation})
				return
			}
			p.doc.Syntax = append(p.doc.Syntax, Token{Line: line, Start: startColumn, Length: uint32(open - i + 1), Type: Interpolation}, Token{Line: line, Start: column + units(text[i:closing]), Length: 1, Type: Interpolation})
			body := text[open+1 : closing]
			bodyColumn := column + uint32(open-i+1)
			if kind == '$' {
				id := p.addExpression(body, line, bodyColumn, false)
				if p.decodedDepth == 0 {
					if p.doc.Substitutions == nil {
						p.doc.Substitutions = make(map[uint64]uint32)
					}
					p.doc.Substitutions[uint64(line)<<32|uint64(bodyColumn)] = id
				}
			} else {
				cut, depth := -1, 0
				for j, r := range body {
					if r == '(' {
						depth++
					}
					if r == ')' {
						depth--
					}
					if white(r) && depth == 0 && j > 0 {
						cut = j
						break
					}
				}
				if cut < 0 {
					p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, startColumn, units(text[i:closing+1]), "multireplace-options", "Multireplace requires an expression and alternatives separated by |.", 1))
				} else {
					p.addExpression(body[:cut], line, bodyColumn, false)
					_, spaceBytes := utf8.DecodeRuneInString(body[cut:])
					options := body[cut+spaceBytes:]
					if !strings.Contains(options, "|") {
						p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, startColumn, units(text[i:closing+1]), "multireplace-options", "Provide at least two alternatives.", 1))
					}
					position := bodyColumn + units(body[:cut+spaceBytes])
					for part := range strings.SplitSeq(options, "|") {
						p.narrative(part, line, position)
						position += units(part) + 1
					}
				}
			}
			column += units(text[i : closing+1])
			i = closing + 1
			continue
		}
		if text[i] == '[' {
			tag := markupPattern.FindString(text[i:])
			if tag != "" {
				p.doc.Syntax = append(p.doc.Syntax, Token{Line: line, Start: column, Length: units(tag), Type: Markup, Modifiers: markupFlags(tag)})
				column += units(tag)
				i += len(tag)
				continue
			}
		}
		r, width := utf8.DecodeRuneInString(text[i:])
		i += width
		column++
		if r > 0xffff {
			column++
		}
	}
}

func (p *parser) parseCommand(index uint32) {
	node := p.doc.mutableRow(int(index))
	line := index - 1
	c := p.names.Names[node.Command]
	a := p.doc.args(index)
	raw := p.doc.raw(index)
	s := units(raw[:node.Arg])
	if _, known := CommandDocs[c]; !known && c != "selectable_if" {
		p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, node.Indent, uint32(len(c)+1), "unknown-command", "Unknown ChoiceScript command *"+c+".", 1))
	}
	if c == "hide_reuse" || c == "disable_reuse" || c == "allow_reuse" {
		if option := strings.IndexByte(a, '#'); option >= 0 {
			node.Inline = node.Arg + uint32(option) + 1
			p.narrative(raw[node.Inline:], line, units(raw[:node.Inline]))
		}
		return
	}
	if c == "comment" {
		p.doc.Syntax = p.doc.Syntax[:node.TokenStart]
		p.doc.Syntax = append(p.doc.Syntax, Token{Line: line, Start: node.Indent, Length: units(raw) - node.Indent, Type: Comment})
		return
	}
	if declarationCommands[c] || c == "set" || c == "setref" || c == "delete" || c == "delete_array" || c == "rand" || c == "input_text" || c == "input_number" {
		ts := p.lex(a, line, s, true)
		if declarationCommands[c] && len(ts) > 0 {
			word := true
			for i := 0; i < len(ts[0].Text); i++ {
				word = word && asciiWord(ts[0].Text[i])
			}
			if word {
				ts[0].Kind = Variable
			}
		}
		if c != "setref" && len(ts) > 0 && ts[0].Kind == Function {
			p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, ts[0].Start, ts[0].Length, "expression-reference", "Expected a variable reference before the value expression.", 1))
		}
		end := 1
		if c == "setref" {
			groups := valueGroups(ts)
			end = 0
			if len(groups) > 0 {
				end = groups[0].End
			}
		} else if len(ts) > 0 && ts[0].Text == "{" {
			depth := 1
			for end < len(ts) && depth > 0 {
				if ts[end].Text == "{" {
					depth++
				}
				if ts[end].Text == "}" {
					depth--
				}
				end++
			}
		} else {
			for end < len(ts) && ts[end].Text == "[" {
				depth := 1
				end++
				for end < len(ts) && depth > 0 {
					if ts[end].Text == "[" {
						depth++
					}
					if ts[end].Text == "]" {
						depth--
					}
					end++
				}
			}
		}
		if end > len(ts) {
			end = len(ts)
		}
		p.addLexemes(ts, line)
		if len(ts) > 0 {
			node.TargetExpr = p.expression(ts[:end], line, c != "setref", c == "setref")
			var target strings.Builder
			for _, token := range ts[:end] {
				target.WriteString(token.Text)
			}
			node.Target = p.names.name(strings.ToLower(target.String()))
			node.TargetToken = ts[0].Span
			if declarationCommands[c] {
				p.doc.Syntax[node.TargetToken].Modifiers |= declared
			}
		} else {
			p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, s, 0, "missing-variable", "Expected a variable name.", 1))
		}
		if declarationCommands[c] && len(ts) > 0 && !validName(ts[0].Text) {
			p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, s, ts[0].Length, "variable-name", "Use a nonreserved variable name starting with a letter.", 1))
		}
		rest := ts[end:]
		if (c == "set" || c == "setref") && len(rest) > 0 && node.TargetExpr != 0 {
			op, found := binaryOps[strings.ToLower(rest[0].Text)]
			if rest[0].Text == "%" {
				op = binaryOps["modulo"]
				found = true
			}
			if found && (op <= 9 || op >= 16) {
				left := node.TargetExpr
				if c == "setref" {
					left = p.appendExpr(expr{Kind: exIndirect, A: left})
				}
				right := p.expression(rest[1:], line, false, true)
				node.Expr = p.appendExpr(expr{Kind: exBinary, Op: op, A: left, B: right})
			}
		}
		if node.Expr == 0 && !strings.HasSuffix(c, "_array") && c != "rand" && c != "input_text" && c != "input_number" && c != "delete" && c != "delete_array" {
			node.Expr = p.expression(rest, line, false, true)
		}
		if c == "create" && len(rest) > 0 && (len(rest) != 1 || rest[0].Kind != Number && rest[0].Kind != Boolean && rest[0].Kind != String || rest[0].Kind == String && containsSubstitution(rest[0].Text)) {
			p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, rest[0].Start, units(raw)-rest[0].Start, "create-literal", "*create requires a simple number, boolean, or string literal.", 1))
		}
		if (c == "create" || c == "set" || c == "setref") && len(rest) == 0 {
			p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, s+units(a), 0, "missing-value", "Expected a value.", 1))
		}
		if node.Expr != 0 && p.doc.Exprs[node.Expr].Kind == exBinary && p.doc.Exprs[node.Expr].B == 0 && len(rest) == 1 {
			p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, units(raw), 0, "missing-value", "Expected a value after the operator.", 1))
		}
		if strings.HasSuffix(c, "_array") {
			var expressions []uint32
			for _, group := range valueGroups(rest) {
				expressions = append(expressions, p.expression(rest[group.Start:group.End], line, false, true))
			}
			node.ExprStart, node.ExprCount = uint32(len(p.doc.Args)), uint32(len(expressions))
			p.doc.Args = append(p.doc.Args, expressions...)
			if len(expressions) > 1 {
				node.Expr = expressions[1]
			}
		}
		return
	}
	if expressionCommands[c] {
		expression := a
		if c == "if" || c == "selectable_if" {
			quoted, depth := false, 0
			for i := 0; i < len(a); i++ {
				if a[i] == '\\' && quoted {
					i++
					continue
				}
				if a[i] == '"' {
					quoted = !quoted
				}
				if quoted {
					continue
				}
				if a[i] == '(' {
					depth++
				}
				if a[i] == ')' {
					depth--
				}
				if a[i] == '#' && depth == 0 && (i == 0 || white(rune(a[i-1]))) {
					expression = a[:i]
					node.Inline = node.Arg + uint32(i) + 1
					p.narrative(raw[node.Inline:], line, units(raw[:node.Inline]))
					break
				}
			}
		}
		node.Expr = p.addExpression(expression, line, s, false)
		if trim(expression) == "" {
			p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, s, 0, "missing-expression", "Expected an expression.", 1))
		}
		return
	}
	if c == "label" || c == "goto" || c == "gosub" || c == "goto_scene" || c == "gosub_scene" || c == "redirect_scene" || c == "gotoref" {
		count := 1
		if strings.HasSuffix(c, "_scene") {
			count = 2
		}
		var ts []lexeme
		var groups []tokenGroup
		if c == "gotoref" {
			ts = p.lex(a, line, s, true)
			groups = valueGroups(ts)
		} else {
			ts, groups = p.referenceGroups(a, line, s, count, true)
		}
		p.addLexemes(ts, line)
		if c != "gotoref" {
			for _, group := range groups[:min(count, len(groups))] {
				if group.End-group.Start == 1 && ts[group.Start].Kind == Variable {
					p.doc.Syntax[ts[group.Start].Span].Type = Label
				}
			}
		}
		if len(ts) > 0 {
			if ts[0].Kind == referenceToken {
				node.TargetExpr = p.appendExpr(expr{Kind: exLiteral, Arg: uint32(p.values.text(ts[0].Text))})
			} else {
				node.TargetExpr = p.expression(ts[groups[0].Start:groups[0].End], line, true, false)
			}
			target := ts[0].Text
			if !strings.HasSuffix(c, "_scene") {
				target = strings.ToLower(target)
			}
			node.Target = p.names.name(target)
			node.TargetToken = ts[0].Span
			if c == "label" {
				p.doc.Syntax[node.TargetToken].Modifiers |= declared
			}
		}
		var references []uint32
		if c == "gotoref" {
			node.Expr = p.expression(ts, line, false, true)
			references = append(references, node.Expr)
		} else {
			for i, group := range groups {
				part := ts[group.Start:group.End]
				var id uint32
				if i < count && len(part) == 1 && (part[0].Kind == referenceToken || part[0].Kind == Variable) {
					id = p.appendExpr(expr{Kind: exLiteral, Arg: uint32(p.values.text(part[0].Text))})
				} else {
					id = p.expression(part, line, true, false)
				}
				references = append(references, id)
			}
		}
		node.ExprStart, node.ExprCount = uint32(len(p.doc.Args)), uint32(len(references))
		p.doc.Args = append(p.doc.Args, references...)
		return
	}
	if c == "params" {
		ts := p.lex(a, line, s, true)
		p.addLexemes(ts, line)
		for _, token := range ts {
			p.doc.Syntax[token.Span].Modifiers |= declared
		}
		return
	}
	if (c == "else" || c == "return" || c == "finish" || c == "ending") && trim(a) != "" {
		if c == "else" {
			p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, s, units(a), "unexpected-argument", "Nothing may follow *else.", 1))
		}
		return
	}
	if c != "script" && !blockCommands[c] {
		p.narrative(a, line, s)
	}
}
func containsSubstitution(s string) bool {
	for i := 0; i < len(s); i++ {
		if _, _, ok := substitution(s, i); ok {
			return true
		}
	}
	return false
}

func parseSource(source Source, scope uint32, names *registry, values *valuePool) *Document {
	return parseSourceChecked(source, scope, names, values, nil)
}
func parseSourceChecked(source Source, scope uint32, names *registry, values *valuePool, check func() error) *Document {
	count := 1 + strings.Count(source.Text, "\n") + strings.Count(source.Text, "\r") - strings.Count(source.Text, "\r\n")
	position, ended := 0, false
	next := func() (string, uint32, uint32, bool) {
		if ended {
			return "", 0, 0, false
		}
		end := position
		for end < len(source.Text) && source.Text[end] != '\n' && source.Text[end] != '\r' {
			end++
		}
		raw, start := source.Text[position:end], position
		if end == len(source.Text) {
			ended = true
		} else {
			position = end + 1
			if source.Text[end] == '\r' && position < len(source.Text) && source.Text[position] == '\n' {
				position++
			}
		}
		return raw, uint32(start), uint32(end), true
	}
	return parseSourceLines(source, scope, names, values, check, count, next)
}

// Parse one physical line at a time. Prose bytes are released immediately after
// their complete syntax, quote transfer, extents and word count are captured.
func parseSourceLines(source Source, scope uint32, names *registry, values *valuePool, check func() error, count int, next func() (string, uint32, uint32, bool)) *Document {
	names.name("")
	doc := &Document{rowCapacity: count + 1, URI: source.URI, Scene: sceneName(source.URI), Version: source.Version, Scope: scope, Rows: make([]row, 1, min(count+1, compactRowThreshold+1)), keepDenseRows: source.denseRows, Syntax: make([]Token, 1, min(count+1, 4096)), Exprs: make([]expr, 1, min(count+1, 4096)), Widths: make([]uint32, 1, count+1), WordCounts: make([]uint32, 1, count+1), RawRows: make(map[uint32]string), Templates: make(map[uint32]textTemplate)}
	p := parser{doc: doc, names: names, values: values, check: check}
	// Sibling bookkeeping belongs to active indentation frames. Once a parent
	// is popped, later lines cannot become its children. Storage therefore
	// follows nesting depth rather than the number of physical source lines.
	type parserFrame struct{ row, previous, lastChild uint32 }
	stack := []parserFrame{{}}
	doc.semanticRowIndex = make([]uint32, 0)
	labelRegions := make(map[uint32]map[uint32]bool)
	style, bom := "", 0
	for {
		if doc.RowCount()&255 == 0 {
			p.poll()
		}
		raw, position, end, ok := next()
		if !ok {
			break
		}
		if doc.RowCount() == 1 && strings.HasPrefix(raw, "\uFEFF") {
			bom = len("\uFEFF")
		}
		index := uint32(doc.RowCount())
		line := index - 1
		offset := 0
		if index == 1 {
			offset = bom
		}
		indentBytes, indentUnits := leading(raw[offset:])
		indentBytes += offset
		if offset > 0 {
			indentUnits++
		}
		body := raw[indentBytes:]
		kind := prose
		if body == "" {
			kind = blank
		} else if body[0] == '*' {
			kind = command
			word := 1
			for word < len(body) && asciiWord(body[word]) {
				word++
			}
			if strings.EqualFold(body[1:word], "comment") {
				kind = comment
			}
		} else if body[0] == '#' {
			kind = option
		}
		if body != "" {
			for len(stack) > 1 {
				top := stack[len(stack)-1].row
				level := doc.rowIndent(top)
				if top == 1 && bom > 0 {
					level--
				}
				current := indentUnits
				if offset > 0 {
					current--
				}
				if level < current {
					break
				}
				stack = stack[:len(stack)-1]
			}
		}
		frame := &stack[len(stack)-1]
		parent := frame.row
		node := row{Start: position, End: end, Indent: indentUnits, IndentBytes: uint32(indentBytes), Arg: uint32(indentBytes), Parent: parent, Inline: noOffset, Kind: kind, TokenStart: uint32(len(doc.Syntax))}
		doc.appendRow(node)
		doc.Widths = append(doc.Widths, 0)
		doc.WordCounts = append(doc.WordCounts, 0)
		if parent == 0 {
			doc.Roots = append(doc.Roots, index)
		} else if frame.lastChild == 0 {
			doc.setFirstChild(int(parent), index)
		} else {
			doc.setNextSibling(int(frame.lastChild), index)
		}
		frame.lastChild = index
		// Blank lines retain their exact extent and tree position, but have no
		// lexical, word-count or indentation-style work. They remain explicit
		// graph nodes so continued-dialogue paragraphs keep their transfer.
		if kind == blank {
			doc.Widths[index] = units(raw)
			continue
		}
		doc.nonBlankRows++
		if kind == command || kind == comment {
			doc.RawRows[index] = raw
		}
		whiteText := raw[offset:indentBytes]
		badWhite, mixed, hasSpace, hasTab := false, false, false, false
		for _, r := range whiteText {
			if r == ' ' {
				hasSpace = true
			} else if r == '\t' {
				hasTab = true
			} else {
				badWhite = true
			}
		}
		if body != "" && badWhite {
			p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, offsetPositive(offset), units(whiteText), "indentation-whitespace", "Indentation may contain only spaces or tabs.", 1))
		}
		if body != "" && !badWhite && (hasSpace || hasTab) {
			current := "spaces"
			if hasTab {
				current = "tabs"
			}
			mixed = hasSpace && hasTab || style != "" && style != current
			if mixed {
				p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, 0, indentUnits, "mixed-indentation", "Use a consistent indentation style.", 1))
			}
			if style == "" {
				style = current
			}
		}
		if body != "" && parent != 0 && (metadataCommands[names.Names[doc.rowAt(int(parent)).Command]] || doc.rowAt(int(parent)).Kind == metadata) {
			doc.mutableRow(int(index)).Kind = metadata
			kind = metadata
		}
		if kind == command || kind == comment {
			word := 1
			for word < len(body) && asciiWord(body[word]) {
				word++
			}
			if word > 1 {
				name := strings.ToLower(body[1:word])
				doc.mutableRow(int(index)).Command = names.name(name)
				spaces, _ := leading(body[word:])
				doc.mutableRow(int(index)).Arg = uint32(indentBytes + word + spaces)
				doc.Syntax = append(doc.Syntax, Token{Line: line, Start: indentUnits, Length: uint32(word), Type: Keyword})
				p.parseCommand(index)
			} else {
				doc.Diagnostics = append(doc.Diagnostics, diagnostic(line, indentUnits, units(body), "command-syntax", "Expected a command name.", 1))
			}
		} else if kind == metadata {
			parentCommand := ""
			if parent != 0 {
				parentCommand = names.Names[doc.rowAt(int(parent)).Command]
			}
			if parentCommand == "goto_random_scene" {
				trimmed := trim(body)
				at := len(trimmed)
				for at > 0 {
					r, n := utf8.DecodeLastRuneInString(trimmed[:at])
					if white(r) {
						break
					}
					at -= n
				}
				if at < len(trimmed) {
					target := trimmed[at:]
					doc.mutableRow(int(index)).Target = names.name(target)
					doc.Syntax = append(doc.Syntax, Token{Line: line, Start: indentUnits + units(body[:at]), Length: units(target), Type: Label})
				}
				if match := randomCondition.FindStringSubmatchIndex(body); match != nil {
					p.addExpression(body[match[2]:match[3]], line, indentUnits+units(body[:match[2]]), false)
				}
			} else if parentCommand == "scene_list" {
				at := 0
				if strings.HasPrefix(body, "$") {
					for at < len(body) && !white(rune(body[at])) {
						at++
					}
					space, _ := leading(body[at:])
					at += space
				}
				end := at
				for end < len(body) {
					r, width := utf8.DecodeRuneInString(body[end:])
					if white(r) {
						break
					}
					end += width
				}
				if end > at {
					doc.mutableRow(int(index)).Target = names.name(body[at:end])
					doc.Syntax = append(doc.Syntax, Token{Line: line, Start: indentUnits + units(body[:at]), Length: units(body[at:end]), Type: Label})
				}
			} else if match := chartPattern.FindStringSubmatchIndex(body); match != nil {
				doc.Syntax = append(doc.Syntax, Token{Line: line, Start: indentUnits, Length: units(body[match[2]:match[3]]), Type: Keyword}, Token{Line: line, Start: indentUnits + units(body[:match[4]]), Length: units(body[match[4]:match[5]]), Type: Variable})
				span := uint32(len(doc.Syntax) - 1)
				p.setTokenName(span, strings.ToLower(body[match[4]:match[5]]))
				p.narrative(body[match[1]:], line, indentUnits+units(body[:match[1]]))
			} else {
				p.narrative(body, line, indentUnits)
			}
		} else {
			start := indentBytes
			if kind == option {
				doc.Syntax = append(doc.Syntax, Token{Line: line, Start: indentUnits, Length: 1, Type: Operator})
				start++
			}
			p.narrative(raw[start:], line, units(raw[:start]))
		}
		if kind != prose && kind != option {
			node = doc.rowAt(int(index))
		}
		commandName := names.Names[node.Command]
		if kind != comment {
			prev := frame.previous
			previousCommand := ""
			if prev != 0 {
				previousCommand = names.Names[doc.rowCommand(prev)]
			}
			if (commandName == "else" || commandName == "elseif" || commandName == "elsif") && previousCommand != "if" && previousCommand != "elseif" && previousCommand != "elsif" {
				doc.Diagnostics = append(doc.Diagnostics, diagnostic(line, node.Indent, units(raw)-node.Indent, "orphan-alternative", "This alternative has no matching *if at the same indentation.", 1))
			}
			frame.previous = index
		}
		doc.setTokenCount(int(index), uint32(len(doc.Syntax))-node.TokenStart)
		if body != "" && kind != comment {
			if commandName == "label" && parent != 0 {
				if labelRegions[parent] == nil {
					labelRegions[parent] = make(map[uint32]bool)
				}
				labelRegions[parent][node.Indent] = true
			}
			if parent != 0 {
				owner := doc.rowAt(int(parent))
				ownerCommand := names.Names[owner.Command]
				if owner.Kind != metadata && owner.Kind != option && !labelRegions[parent][node.Indent] && !blockCommands[ownerCommand] && !transferCommands[ownerCommand] && owner.Inline == noOffset {
					doc.Diagnostics = append(doc.Diagnostics, diagnostic(line, 0, max(uint32(1), node.Indent), "unexpected-indent", "Unexpected indentation after a non-block line.", 1))
				}
			}
			stack = append(stack, parserFrame{row: index})
		}
		// Only code/reference passes consume this index. Every physical row
		// still enters the graph, quote transfers and final semantic rendering.
		if kind != prose && kind != option || uint32(len(doc.Syntax)) != node.TokenStart {
			doc.semanticRowIndex = append(doc.semanticRowIndex, index)
		}
		doc.compactRow(index, raw)
	}
	for _, i := range doc.semanticRows() {
		node := doc.rowAt(int(i))
		c := names.Names[node.Command]
		if !blockCommands[c] || node.Inline != noOffset {
			continue
		}
		found := false
		for child := node.FirstChild; child != 0; child = doc.rowAt(int(child)).NextSibling {
			kind := doc.rowAt(int(child)).Kind
			if kind != blank && (kind != comment || c == "if" || c == "elseif" || c == "elsif" || c == "else") {
				found = true
				break
			}
		}
		if !found {
			doc.Diagnostics = append(doc.Diagnostics, diagnostic(i-1, node.Indent, units(doc.raw(i))-node.Indent, "missing-block", "Expected an indented block.", 1))
		}
	}
	doc.packMetrics()
	if doc.rowData != nil {
		doc.rowData.packLinks()
	}
	doc.rowCapacity = 0
	doc.syntaxDiagnostics = len(doc.Diagnostics)
	p.poll()
	return doc
}
func offsetPositive(offset int) uint32 {
	if offset > 0 {
		return 1
	}
	return 0
}
func (p *parser) setTokenName(span uint32, name string) {
	if p.doc.TokenName == nil {
		p.doc.TokenName = make(map[uint32]uint32)
	}
	p.doc.TokenName[span] = p.names.name(name)
}

// physicalLines preserves CR, LF, CRLF and the final empty physical line without
// buffering the entire scene. Scanner's default token size is intentionally avoided.
// A line wholly within the read buffer is borrowed until the next call. The
// parser finishes and compacts that row before advancing: retained RawRows,
// interned names and string values all own cloned strings. Multi-buffer lines
// use their own string allocation. Never expose this iterator outside parsing.
func physicalLines(r io.Reader, lineCapacity int) func() (string, uint32, uint32, bool) {
	size := 65536
	if lineCapacity > 65536 {
		size = 1024 * 1024
	}
	buffer := make([]byte, size)
	offset, available := 0, 0
	var position uint32
	var pending error
	ended, afterCR := false, false
	refill := func() bool {
		if offset < available {
			return true
		}
		if pending != nil {
			if errors.Is(pending, io.EOF) {
				return false
			}
			panic(sourceReadFailure{pending})
		}
		for range 100 {
			n, err := r.Read(buffer)
			offset, available, pending = 0, n, err
			if n > 0 {
				return true
			}
			if err != nil {
				if errors.Is(err, io.EOF) {
					return false
				}
				panic(sourceReadFailure{err})
			}
		}
		panic(sourceReadFailure{io.ErrNoProgress})
	}
	return func() (string, uint32, uint32, bool) {
		if ended {
			return "", 0, 0, false
		}
		// Delay CRLF lookahead until the next call: refilling must never
		// invalidate a borrowed line before the parser has compacted it.
		if afterCR {
			if refill() && buffer[offset] == '\n' {
				offset++
				position++
			}
			afterCR = false
		}
		start := position
		var pieces []byte
		for {
			if !refill() {
				ended = true
				return string(pieces), start, position, true
			}
			chunk := buffer[offset:available]
			at := bytes.IndexByte(chunk, '\n')
			before := chunk
			if at >= 0 {
				before = chunk[:at+1]
			}
			if cr := bytes.IndexByte(before, '\r'); cr >= 0 {
				at = cr
			}
			if at < 0 {
				pieces = append(pieces, chunk...)
				position += uint32(len(chunk))
				offset = available
				continue
			}
			var raw string
			if len(pieces) == 0 {
				raw = unsafe.String(unsafe.SliceData(chunk), at)
			} else {
				pieces = append(pieces, chunk[:at]...)
				raw = string(pieces)
			}
			end := position + uint32(at)
			offset += at + 1
			position = end + 1
			afterCR = chunk[at] == '\r'
			return raw, start, end, true
		}
	}
}
