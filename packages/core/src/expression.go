package core

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

const referenceToken uint8 = 32

type lexeme struct {
	Text                string
	Start, Length, Span uint32
	Kind                uint8
}
type tokenGroup struct{ Start, End int }
type parser struct {
	check        func() error
	doc          *Document
	names        *registry
	values       *valuePool
	decodedDepth int
}

var binaryOps = map[string]uint8{"+": 1, "-": 2, "*": 3, "/": 4, "&": 5, "%+": 6, "%-": 7, "^": 8, "#": 9, "=": 10, "!=": 11, "<": 12, ">": 13, "<=": 14, ">=": 15, "and": 16, "or": 17, "modulo": 18}
var functionNames = map[string]bool{"not": true, "round": true, "timestamp": true, "log": true, "length": true, "auto": true}

func (p *parser) lex(text string, line, offset uint32, report bool) []lexeme {
	p.poll()
	result := make([]lexeme, 0, 8)
	column := offset
	for i := 0; i < len(text); {
		r, width := utf8.DecodeRuneInString(text[i:])
		if white(r) {
			i += width
			column++
			if r > 0xffff {
				column++
			}
			continue
		}
		start, startColumn := i, column
		kind := Operator
		if text[i] == '"' {
			i++
			column++
			closed := false
			for i < len(text) {
				if text[i] == '\\' {
					i++
					column++
					if i < len(text) {
						r, width = utf8.DecodeRuneInString(text[i:])
						i += width
						column++
						if r > 0xffff {
							column++
						}
					}
					continue
				}
				r, width = utf8.DecodeRuneInString(text[i:])
				i += width
				column++
				if r > 0xffff {
					column++
				}
				if r == '"' {
					closed = true
					break
				}
			}
			kind = String
			if !closed && report {
				p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, startColumn, column-startColumn, "expression-string", "Expression string must close on this line.", 1))
			}
		} else if r == '“' || r == '”' {
			i += width
			column++
			if report {
				p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, startColumn, 1, "expression-smart-quote", "Use straight double quotes in expressions.", 1))
			}
		} else if text[i] >= '0' && text[i] <= '9' {
			for i < len(text) && text[i] >= '0' && text[i] <= '9' {
				i++
			}
			digits := i
			if i+1 < len(text) && text[i] == '.' && text[i+1] >= '0' && text[i+1] <= '9' {
				i++
				for i < len(text) && text[i] >= '0' && text[i] <= '9' {
					i++
				}
			}
			if i < len(text) && asciiWord(text[i]) {
				if digits < len(text) && text[digits] == '.' {
					i = digits
				} else {
					i = start + 1
				}
			}
			column += uint32(i - start)
			kind = Number
		} else if asciiLetter(text[i]) || text[i] == '_' {
			for i < len(text) && asciiWord(text[i]) {
				i++
			}
			word := text[start:i]
			lower := strings.ToLower(word)
			switch lower {
			case "true", "false":
				kind = Boolean
			case "and", "or", "modulo":
				kind = Operator
			default:
				kind = Variable
				if functionNames[word] {
					n, _ := leading(text[i:])
					if i+n < len(text) && text[i+n] == '(' {
						kind = Function
					}
				}
			}
			column += uint32(i - start)
		} else {
			i += width
			column++
			if r > 0xffff {
				column++
			}
			if width == 1 && i < len(text) && ((text[start] == '%' && (text[i] == '+' || text[i] == '-')) || (strings.ContainsRune("!<>", r) && text[i] == '=')) {
				i++
				column++
			}
			if !strings.ContainsRune("()[]{}+-*/&%^#=<>!,", r) && report {
				p.doc.Diagnostics = append(p.doc.Diagnostics, diagnostic(line, startColumn, column-startColumn, "expression-character", "Unexpected character "+text[start:i]+" in expression.", 1))
			}
		}
		result = append(result, lexeme{Text: text[start:i], Start: startColumn, Length: column - startColumn, Kind: kind})
	}
	return result
}

func (p *parser) addLexemes(tokens []lexeme, line uint32) {
	for i := range tokens {
		token := &tokens[i]
		if token.Kind == String {
			decoded, offsets := unescapeString(token.Text)
			startTokens, startDiagnostics := len(p.doc.Syntax), len(p.doc.Diagnostics)
			p.decodedDepth++
			p.narrative(decoded, line, 0)
			p.decodedDepth--
			for j := startTokens; j < len(p.doc.Syntax); j++ {
				span := &p.doc.Syntax[j]
				end := span.Start + span.Length
				if int(span.Start) >= len(offsets) || int(end) >= len(offsets) {
					continue
				}
				span.Start, span.Length = token.Start+offsets[span.Start], offsets[end]-offsets[span.Start]
			}
			for j := startDiagnostics; j < len(p.doc.Diagnostics); j++ {
				d := &p.doc.Diagnostics[j]
				start, end := d.Range.Start.Character, d.Range.End.Character
				if int(start) >= len(offsets) {
					start = uint32(len(offsets) - 1)
				}
				if int(end) >= len(offsets) {
					end = uint32(len(offsets) - 1)
				}
				d.Range.Start.Character = token.Start + offsets[start]
				d.Range.End.Character = token.Start + offsets[end]
			}
		}
		kind := token.Kind
		if kind == referenceToken {
			kind = Label
		}
		token.Span = uint32(len(p.doc.Syntax))
		if token.Kind == Variable {
			p.setTokenName(token.Span, strings.ToLower(token.Text))
		}
		p.doc.Syntax = append(p.doc.Syntax, Token{Line: line, Start: token.Start, Length: token.Length, Type: kind})
	}
}

func valueGroups(tokens []lexeme) []tokenGroup {
	var groups []tokenGroup
	for i := 0; i < len(tokens); {
		start := i
		first := tokens[i]
		i++
		group := func() {
			var stack []string
			for position := i - 1; position < len(tokens); position++ {
				t := tokens[position].Text
				switch t {
				case "(":
					stack = append(stack, ")")
				case "{":
					stack = append(stack, "}")
				case "[":
					stack = append(stack, "]")
				default:
					if len(stack) > 0 && stack[len(stack)-1] == t {
						stack = stack[:len(stack)-1]
					}
				}
				i = position + 1
				if len(stack) == 0 {
					return
				}
			}
		}
		if first.Text == "(" || first.Text == "{" || first.Text == "[" {
			group()
		} else if first.Kind == Function && i < len(tokens) && tokens[i].Text == "(" {
			i++
			group()
		}
		for i < len(tokens) && tokens[i].Text == "[" {
			i++
			group()
		}
		groups = append(groups, tokenGroup{start, i})
	}
	return groups
}

func (p *parser) referenceGroups(text string, line, offset uint32, count int, report bool) ([]lexeme, []tokenGroup) {
	if strings.ContainsAny(text, "[{") {
		tokens := p.lex(text, line, offset, report)
		return tokens, valueGroups(tokens)
	}
	var tokens []lexeme
	var groups []tokenGroup
	position := 0
	for range count {
		spaces, _ := leading(text[position:])
		position += spaces
		if position >= len(text) {
			break
		}
		start := position
		for position < len(text) {
			r, width := utf8.DecodeRuneInString(text[position:])
			if white(r) {
				break
			}
			position += width
		}
		tokens = append(tokens, lexeme{Text: text[start:position], Start: offset + units(text[:start]), Length: units(text[start:position]), Kind: referenceToken})
		groups = append(groups, tokenGroup{len(tokens) - 1, len(tokens)})
	}
	rest := p.lex(text[position:], line, offset+units(text[:position]), report)
	for _, group := range valueGroups(rest) {
		groups = append(groups, tokenGroup{group.Start + len(tokens), group.End + len(tokens)})
	}
	tokens = append(tokens, rest...)
	return tokens, groups
}

type expressionParser struct {
	owner  *parser
	tokens []lexeme
	index  int
	line   uint32
	report bool
}

func (p *parser) appendExpr(e expr) uint32 {
	id := uint32(len(p.doc.Exprs))
	p.doc.Exprs = append(p.doc.Exprs, e)
	return id
}
func (p *parser) expression(tokens []lexeme, line uint32, partial, report bool) uint32 {
	if len(tokens) == 0 {
		return 0
	}
	e := expressionParser{owner: p, tokens: tokens, line: line, report: report}
	result := e.expression("", false)
	if !partial && e.index < len(tokens) {
		e.fail("Unexpected additional tokens; ChoiceScript requires parentheses around compound expressions.", -1)
	}
	return result
}
func (e *expressionParser) fail(message string, index int) {
	if !e.report || len(e.tokens) == 0 {
		return
	}
	if index < 0 {
		index = e.index
	}
	if index >= len(e.tokens) {
		index = len(e.tokens) - 1
	}
	t := e.tokens[index]
	e.owner.doc.Diagnostics = append(e.owner.doc.Diagnostics, diagnostic(e.line, t.Start, t.Length, "expression-syntax", message, 1))
}
func (e *expressionParser) at(text string) bool {
	return e.index < len(e.tokens) && e.tokens[e.index].Text == text
}
func (e *expressionParser) value() uint32 {
	if e.index >= len(e.tokens) {
		e.fail("Expected a value.", -1)
		return 0
	}
	index := e.index
	t := e.tokens[index]
	e.index++
	p := e.owner
	switch t.Kind {
	case Number:
		n, _ := strconv.ParseFloat(t.Text, 64)
		return p.appendExpr(expr{Kind: exLiteral, Arg: uint32(p.values.number(n))})
	case Boolean:
		return p.appendExpr(expr{Kind: exLiteral, Arg: uint32(p.values.boolean(strings.EqualFold(t.Text, "true")))})
	case String:
		if len(t.Text) > 1 && strings.HasSuffix(t.Text, "\"") {
			text, _ := unescapeString(t.Text)
			return p.appendExpr(expr{Kind: exLiteral, Arg: uint32(p.values.text(text))})
		}
		return 0
	}
	if t.Text == "-" {
		e.fail("ChoiceScript does not accept unary minus here; write (0 - value).", index)
		e.value()
		return 0
	}
	if t.Text == "(" || t.Text == "{" {
		closing := ")"
		if t.Text == "{" {
			closing = "}"
		}
		value := e.expression(closing, false)
		if t.Text == "{" {
			return p.appendExpr(expr{Kind: exIndirect, A: value})
		}
		return value
	}
	if t.Kind == Function {
		name := strings.ToLower(t.Text)
		if !functionNames[name] {
			e.fail("Unknown ChoiceScript function "+name+".", index)
		}
		if e.at("(") {
			e.index++
		}
		args := []uint32{e.expression(")", true)}
		for e.at(",") {
			e.index++
			args = append(args, e.expression(")", true))
		}
		if e.at(")") {
			e.index++
		} else {
			e.fail("Expected closing parenthesis.", -1)
		}
		if name != "auto" && len(args) != 1 {
			e.fail("This function accepts one expression.", index)
		}
		start := uint32(len(p.doc.Args))
		p.doc.Args = append(p.doc.Args, args...)
		return p.appendExpr(expr{Kind: exCall, Arg: p.names.name(name), A: start, B: uint32(len(args))})
	}
	if t.Kind == Variable {
		name := p.names.name(strings.ToLower(t.Text))
		var indexes []uint32
		for e.at("[") {
			e.index++
			indexes = append(indexes, e.expression("]", false))
		}
		if len(indexes) > 0 {
			start := uint32(len(p.doc.Args))
			p.doc.Args = append(p.doc.Args, indexes...)
			id := p.appendExpr(expr{Kind: exArray, Arg: name, A: start, B: uint32(len(indexes))})
			if t.Span != 0 {
				if p.doc.TokenExpr == nil {
					p.doc.TokenExpr = make(map[uint32]uint32)
				}
				p.doc.TokenExpr[t.Span] = id
			}
			return id
		}
		return p.appendExpr(expr{Kind: exVariable, Arg: name})
	}
	e.fail("Expected a value.", index)
	return 0
}
func (e *expressionParser) expression(close string, stopComma bool) uint32 {
	left := e.value()
	if e.index < len(e.tokens) && e.tokens[e.index].Text != close && (!stopComma || e.tokens[e.index].Text != ",") {
		t := e.tokens[e.index]
		if op, ok := binaryOps[strings.ToLower(t.Text)]; ok {
			e.index++
			right := e.value()
			left = e.owner.appendExpr(expr{Kind: exBinary, Op: op, A: left, B: right})
		} else {
			e.fail("Expected an operator or closing delimiter.", -1)
		}
	}
	if close != "" && !stopComma {
		if e.at(close) {
			e.index++
		} else {
			e.fail("Expected "+close+"; use parentheses around compound expressions.", -1)
		}
	}
	return left
}

func (p *parser) addExpression(text string, line, offset uint32, partial bool) uint32 {
	tokens := p.lex(text, line, offset, true)
	p.addLexemes(tokens, line)
	return p.expression(tokens, line, partial, true)
}

// evaluate follows the pinned interpreter's type/coercion model conservatively.
// lookup owns scope/array resolution and observation; host code is never executed.
func evaluate(d *Document, id uint32, names *registry, values *valuePool, lookup func(uint32) Value) Value {
	if id == 0 || int(id) >= len(d.Exprs) {
		return UnknownType
	}
	e := d.Exprs[id]
	switch e.Kind {
	case exLiteral:
		value := Value(e.Arg)
		if primitive, ok := values.constant(value); ok && Value(primitive.Kind) == StringType && (strings.Contains(primitive.Text, "${") || strings.Contains(primitive.Text, "$!{") || strings.Contains(primitive.Text, "$!!{") || strings.Contains(primitive.Text, "@{") || strings.Contains(primitive.Text, "@!{") || strings.Contains(primitive.Text, "@!!{")) {
			return StringType
		}
		return value
	case exVariable:
		return lookup(e.Arg)
	case exArray:
		name := names.Names[e.Arg]
		for _, index := range d.Args[e.A : e.A+e.B] {
			value := evaluate(d, index, names, values, lookup)
			constant, ok := values.constant(value)
			if !ok {
				suffix := "_*"
				if value&(StringType|UnknownType) != 0 {
					suffix = "_$any"
				}
				return lookup(names.name(name + suffix))
			}
			name += "_" + constant.string()
		}
		return lookup(names.name(name))
	case exIndirect:
		value := evaluate(d, e.A, names, values, lookup)
		if constant, ok := values.constant(value); ok {
			spelling := strings.ToLower(constant.string())
			if literal := values.lookupConstant(spelling); literal != 0 {
				return literal
			}
			return lookup(names.name(spelling))
		}
		return UnknownType
	case exCall:
		name := names.Names[e.Arg]
		if name == "not" {
			return BoolType
		}
		if functionNames[name] {
			return NumberType
		}
		return UnknownType
	case exBinary:
		a, b := evaluate(d, e.A, names, values, lookup), evaluate(d, e.B, names, values, lookup)
		x, xKnown := values.constant(a)
		y, yKnown := values.constant(b)
		if e.Op == 5 {
			if xKnown && yKnown {
				return values.text(x.string() + y.string())
			}
			return values.abstract(StringType, composeQuoteEffects(values.quote(a), values.quote(b)))
		}
		if e.Op == 9 {
			return StringType
		}
		if e.Op >= 10 && e.Op <= 17 {
			return BoolType
		}
		if xKnown && yKnown && Value(x.Kind) == NumberType && Value(y.Kind) == NumberType {
			var n float64
			known := true
			switch e.Op {
			case 1:
				n = x.Number + y.Number
			case 2:
				n = x.Number - y.Number
			case 3:
				n = x.Number * y.Number
			case 4:
				n = x.Number / y.Number
			case 8:
				n = math.Pow(x.Number, y.Number)
			case 18:
				n = math.Mod(x.Number, y.Number)
			default:
				known = false
			}
			if known && !math.IsNaN(n) && !math.IsInf(n, 0) {
				return values.number(n)
			}
		}
		return NumberType
	}
	return UnknownType
}
