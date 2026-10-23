// Package core implements editor-independent ChoiceScript analysis. Source bytes
// are retained once per scene; positions exposed to editors are UTF-16 columns.
package core

import (
	_ "embed"
	"encoding/json"
	"math"
	"net/url"
	"path"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

//go:embed commands.json
var commandJSON []byte

// CommandDocs is shared with the reference implementation and both editor hosts.
var CommandDocs = func() map[string]string {
	var result map[string]string
	if err := json.Unmarshal(commandJSON, &result); err != nil {
		panic(err)
	}
	return result
}()

var TokenTypes = []string{"keyword", "comment", "string", "number", "operator", "variable", "function", "label", "boolean", "dialogue", "narrative", "stringVariable", "numberVariable", "booleanVariable", "markup", "interpolation"}
var TokenModifiers = []string{"declaration", "readonly", "bold", "italic"}

const (
	Keyword uint8 = iota
	Comment
	String
	Number
	Operator
	Variable
	Function
	Label
	Boolean
	Dialogue
	Narrative
	StringVariable
	NumberVariable
	BooleanVariable
	Markup
	Interpolation
)
const (
	declared uint8 = 1
	bold     uint8 = 4
	italic   uint8 = 8
)
const (
	blank uint8 = iota
	comment
	command
	prose
	option
	metadata
)
const noOffset = ^uint32(0)

// Position and Range use exclusive ends and the LSP UTF-16 coordinate system.
type Position struct {
	Line      uint32 `json:"line"`
	Character uint32 `json:"character"`
}
type Range struct {
	Start Position `json:"start"`
	End   Position `json:"end"`
}
type Diagnostic struct {
	Range    Range  `json:"range"`
	Message  string `json:"message"`
	Code     string `json:"code"`
	Severity uint8  `json:"severity"`
	Source   string `json:"source"`
}
type Source struct {
	denseRows bool
	URI       string `json:"uri"`
	Text      string `json:"text"`
	Version   int32  `json:"version"`
}
type Location struct {
	URI   string `json:"uri"`
	Range Range  `json:"range"`
}
type Token struct {
	Line, Start, Length, Symbol, ReferenceLength uint32
	Type, Modifiers                              uint8
}

// A row stores offsets into its scene's source, never a pointer-rich syntax tree.
// Expression IDs and token ranges refer to contiguous per-scene arenas.
type row struct {
	Start, End, Indent, IndentBytes, Arg, Command uint32
	Parent, FirstChild, NextSibling               uint32
	Expr, TargetExpr, ExprStart, ExprCount        uint32
	TokenStart, TokenCount, TargetToken, Target   uint32
	Inline                                        uint32
	Kind                                          uint8
	Flags                                         uint8
}
type expr struct {
	Kind, Op  uint8
	Arg, A, B uint32
}

const (
	_ uint8 = iota // Zero represents an absent or unknown expression.
	exLiteral
	exVariable
	exIndirect
	exArray
	exCall
	exBinary
)

// Value codes contain a four-bit type set and an optional interned primitive ID.
// They are immutable, cheap to join, and never execute source code.
type Value uint32

const (
	BoolType    Value = 1
	NumberType  Value = 2
	StringType  Value = 4
	UnknownType Value = 8
)

type primitive struct {
	Quote    uint32
	Abstract bool
	Text     string
	Number   float64
	Kind     uint8
}
type valuePool struct {
	entries []primitive
	index   map[primitive]uint32
}

func (p *valuePool) literal(v primitive) Value {
	if !v.Abstract && Value(v.Kind) == StringType && v.Quote == 0 {
		v.Quote = literalQuoteEffect(v.Text)
	}
	if p.index == nil {
		p.index = make(map[primitive]uint32)
		p.entries = append(p.entries, primitive{})
	}
	id, exists := p.index[v]
	if !exists {
		id = uint32(len(p.entries))
		if Value(v.Kind) == StringType {
			v.Text = strings.Clone(v.Text)
		}
		p.entries = append(p.entries, v)
		p.index[v] = id
	}
	return Value(id<<4) | Value(v.Kind)
}
func (p *valuePool) number(n float64) Value {
	return p.literal(primitive{Number: n, Kind: uint8(NumberType)})
}
func (p *valuePool) text(s string) Value {
	return p.literal(primitive{Text: s, Kind: uint8(StringType)})
}
func (p *valuePool) boolean(v bool) Value {
	n := 0.0
	if v {
		n = 1
	}
	return p.literal(primitive{Number: n, Kind: uint8(BoolType)})
}
func (p *valuePool) constant(v Value) (primitive, bool) {
	if v&bindingPresence != 0 {
		return primitive{}, false
	}
	id := uint32(v) >> 4
	if id == 0 || int(id) >= len(p.entries) {
		return primitive{}, false
	}
	if p.entries[id].Abstract {
		return primitive{}, false
	}
	return p.entries[id], true
}
func joinValue(a, b Value) Value {
	if a == b {
		return a
	}
	if a == 0 {
		a = UnknownType
	}
	if b == 0 {
		b = UnknownType
	}
	constant := Value(0)
	if a>>4 == b>>4 {
		constant = a &^ 15
	}
	return (a|b)&15 | constant
}
func (p primitive) string() string {
	switch Value(p.Kind) {
	case StringType:
		return p.Text
	case BoolType:
		if p.Number != 0 {
			return "true"
		}
		return "false"
	default:
		if p.Number == 0 {
			return "0"
		}
		if math.IsInf(p.Number, 1) {
			return "Infinity"
		}
		if math.IsInf(p.Number, -1) {
			return "-Infinity"
		}
		if math.IsNaN(p.Number) {
			return "NaN"
		}
		format := byte('f')
		if math.Abs(p.Number) >= 1e21 || math.Abs(p.Number) < 1e-6 {
			format = 'g'
		}
		return strings.ReplaceAll(strings.ReplaceAll(strconv.FormatFloat(p.Number, format, -1, 64), "e-0", "e-"), "e+0", "e+")
	}
}
func typeNames(v Value) []string {
	result := make([]string, 0, 4)
	for _, item := range []struct {
		bit  Value
		name string
	}{{BoolType, "boolean"}, {NumberType, "number"}, {StringType, "string"}, {UnknownType, "unknown"}} {
		if v&item.bit != 0 {
			result = append(result, item.name)
		}
	}
	return result
}

type key struct{ Scope, Name uint32 }
type registry struct {
	Names []string
	names map[string]uint32
	Keys  []key
	keys  map[key]uint32
}

func (r *registry) name(s string) uint32 {
	if r.names == nil {
		r.names = map[string]uint32{"": 0}
		r.Names = append(r.Names, "")
		r.keys = make(map[key]uint32)
		r.Keys = append(r.Keys, key{})
	}
	if id, ok := r.names[s]; ok {
		return id
	}
	id := uint32(len(r.Names))
	s = strings.Clone(s)
	r.Names = append(r.Names, s)
	r.names[s] = id
	return id
}
func (r *registry) key(scope, name uint32) uint32 {
	k := key{scope, name}
	if id, ok := r.keys[k]; ok {
		return id
	}
	id := uint32(len(r.Keys))
	r.Keys = append(r.Keys, k)
	r.keys[k] = id
	return id
}

// Document owns source syntax; query snapshots can discard it after producing
// compact semantic/index data. Rows are 1-based internally so zero is no parent.
type Document struct {
	widthMetrics, wordMetrics *numericMetrics
	semanticRowIndex          []uint32
	rowCapacity               int
	nonBlankRows              int
	rowData                   *sourceRows
	keepDenseRows             bool
	substitutionRows          map[uint32][]uint32
	URI, Scene, Text          string
	Version                   int32
	Scope                     uint32
	Rows                      []row
	QueryRows                 []queryRow
	Roots                     []uint32
	Syntax                    []Token
	Exprs                     []expr
	Args                      []uint32
	Diagnostics               []Diagnostic
	syntaxDiagnostics         int
	TokenExpr                 map[uint32]uint32
	TokenName                 map[uint32]uint32
	Substitutions             map[uint64]uint32
	Widths, WordCounts        []uint32
	ProseEntries              []uint8
	ProseEffects              []uint64
	RawRows                   map[uint32]string
	Templates                 map[uint32]textTemplate
	QuoteMarks                []quoteMark
}

func (d *Document) raw(line uint32) string {
	r := d.rowAt(int(line))
	if d.Text == "" {
		return d.RawRows[line]
	}
	return d.Text[r.Start:r.End]
}
func (d *Document) args(line uint32) string {
	r := d.rowAt(int(line))
	raw := d.raw(line)
	if int(r.Arg) > len(raw) {
		return ""
	}
	return raw[r.Arg:]
}
func (d *Document) children(parent uint32) []uint32 {
	if parent == 0 {
		return d.Roots
	}
	var result []uint32
	for i := d.rowAt(int(parent)).FirstChild; i != 0; i = d.rowAt(int(i)).NextSibling {
		result = append(result, i)
	}
	return result
}
func sceneName(uri string) string {
	if parsed, err := url.Parse(uri); err == nil {
		uri = parsed.Path
	}
	name := path.Base(uri)
	if len(name) >= 4 && strings.EqualFold(name[len(name)-4:], ".txt") {
		name = name[:len(name)-4]
	}
	return name
}
func units(s string) uint32 {
	var n uint32
	for _, r := range s {
		n++
		if r > 0xffff {
			n++
		}
	}
	return n
}
func unitBytes(s string, column uint32) int {
	var n uint32
	for i, r := range s {
		if n >= column {
			return i
		}
		n++
		if r > 0xffff {
			n++
		}
	}
	return len(s)
}
func unescapeString(s string) (string, []uint32) {
	u := utf16.Encode([]rune(s))
	end := len(u)
	if end > 1 && u[end-1] == '"' {
		end--
	}
	decoded := make([]uint16, 0, end)
	offsets := make([]uint32, 0, end)
	for i := 1; i < end; i++ {
		offsets = append(offsets, uint32(i))
		if u[i] == '\\' && i+1 < end {
			i++
		}
		decoded = append(decoded, u[i])
	}
	offsets = append(offsets, uint32(end))
	return string(utf16.Decode(decoded)), offsets
}
func validName(s string) bool {
	if len(s) == 0 || !asciiLetter(s[0]) {
		return false
	}
	for i := 1; i < len(s); i++ {
		if !asciiWord(s[i]) {
			return false
		}
	}
	s = strings.ToLower(s)
	return s != "and" && s != "or" && s != "true" && s != "false" && s != "scene" && s != "scenename" && !strings.HasPrefix(s, "choice_")
}
func asciiLetter(b byte) bool { return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' }
func asciiWord(b byte) bool   { return asciiLetter(b) || b >= '0' && b <= '9' || b == '_' }
func white(r rune) bool {
	return r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f' || r == 0xfeff || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000
}
func leading(s string) (bytes int, columns uint32) {
	for bytes < len(s) {
		r, n := utf8.DecodeRuneInString(s[bytes:])
		if !white(r) {
			break
		}
		bytes += n
		columns++
		if r > 0xffff {
			columns++
		}
	}
	return
}
func diagnostic(line, start, length uint32, code, message string, severity uint8) Diagnostic {
	source := "ChoiceScript"
	if strings.HasPrefix(code, "quote-") {
		source = "ChoiceScript dialogue"
	}
	return Diagnostic{Range: Range{Position{line, start}, Position{line, start + length}}, Code: code, Message: message, Severity: severity, Source: source}
}

func (d *Document) proseEffect(line uint32) uint64 {
	if len(d.ProseEffects) == 0 {
		return 0
	}
	return d.ProseEffects[line]
}
