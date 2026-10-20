package core

import (
	"errors"
	"io"
	"regexp"
	"sort"
	"strings"
)

func (p *Project) DocumentIndex(uri string) (uint32, bool) {
	for index, d := range p.Documents {
		if d.URI == uri {
			return uint32(index), true
		}
	}
	return 0, false
}

// TokenAt uses ordered disjoint spans so long source files do not make hover or
// navigation linear in the total number of semantic classifications.
func (p *Project) TokenAt(doc uint32, position Position) *Token {
	if int(doc) >= len(p.Tokens) {
		return nil
	}
	tokens := p.TokenSequence(doc)
	index := sort.Search(tokens.Len(), func(i int) bool {
		t := tokens.At(i)
		return t.Line > position.Line || t.Line == position.Line && t.Start+t.Length > position.Character
	})
	if index == tokens.Len() {
		return nil
	}
	value := tokens.At(index)
	t := &value
	if t.Line != position.Line || position.Character < t.Start {
		return nil
	}
	return t
}
func tokenRange(t Token, reference bool) Range {
	length := t.Length
	if reference && t.ReferenceLength > 0 {
		length = t.ReferenceLength
	}
	return Range{Position{t.Line, t.Start}, Position{t.Line, t.Start + length}}
}
func (p *Project) Definition(doc uint32, position Position) *Location {
	t := p.TokenAt(doc, position)
	if t == nil || t.Symbol == 0 {
		return nil
	}
	location := p.Symbols[t.Symbol].Location
	return &location
}
func (p *Project) References(doc uint32, position Position, includeDeclaration bool) []Location {
	result := []Location{}
	t := p.TokenAt(doc, position)
	if t == nil || t.Symbol == 0 {
		return result
	}
	declaration := p.Symbols[t.Symbol].Location
	for index := range p.Documents {
		for _, token := range p.TokenSequence(uint32(index)).All() {
			if token.Symbol == t.Symbol {
				location := Location{p.Documents[index].URI, tokenRange(token, true)}
				if includeDeclaration || location != declaration {
					result = append(result, location)
				}
			}
		}
	}
	return result
}
func (p *Project) PrepareRename(doc uint32, position Position) *Range {
	t := p.TokenAt(doc, position)
	if t == nil || t.Symbol == 0 || p.unsafeRenames[t.Symbol] || p.Symbols[t.Symbol].Kind == "scene" {
		return nil
	}
	r := tokenRange(*t, true)
	return &r
}

type TextEdit struct {
	Range   Range  `json:"range"`
	NewText string `json:"newText"`
}
type WorkspaceEdit struct {
	Changes map[string][]TextEdit `json:"changes"`
}

var identifierPattern = regexp.MustCompile(`^[A-Za-z]\w*$`)

func generatedName(base, candidate string) bool {
	return strings.HasPrefix(candidate, base+"_") && arraySuffix.MatchString(candidate[len(base)+1:]) && candidate != base+"_*"
}
func (p *Project) Rename(doc uint32, position Position, name string) (*WorkspaceEdit, error) {
	if !identifierPattern.MatchString(name) {
		return nil, errors.New("names must start with a letter and contain only letters, digits, or underscores")
	}
	if p.PrepareRename(doc, position) == nil {
		return nil, nil
	}
	t := p.TokenAt(doc, position)
	old := p.Symbols[t.Symbol]
	variable := old.Kind == "global" || old.Kind == "local"
	if variable && !validName(name) {
		return nil, errors.New("that name is reserved by ChoiceScript")
	}
	refs := p.References(doc, position, true)
	affected := make(map[string]bool)
	for _, ref := range refs {
		affected[ref.URI] = true
	}
	visible := func(s Symbol) bool {
		return s.Kind == "global" || old.Kind == "global" && affected[s.Location.URI] || old.Kind != "global" && s.Location.URI == old.Location.URI
	}
	arrays := p.arraySymbols
	parameterScopes := p.parameterScenes

	target := strings.ToLower(name)
	for id, s := range p.Symbols {
		if uint32(id) == t.Symbol {
			continue
		}
		if old.Kind == "label" && s.Kind == "label" && s.Location.URI == old.Location.URI && s.Name == target {
			return nil, errors.New("that label already exists in this scene")
		}
		if variable && (s.Kind == "global" || s.Kind == "local") && visible(s) {
			if s.Name == target || arrays[t.Symbol] && strings.HasPrefix(s.Name, target+"_") || arrays[uint32(id)] && generatedName(s.Name, target) {
				return nil, errors.New("that name already exists in this scope")
			}
			if arrays[t.Symbol] && strings.HasPrefix(s.Name, old.Name+"_") || arrays[uint32(id)] && generatedName(s.Name, old.Name) {
				return nil, errors.New("this name overlaps an implicit runtime variable; rename it manually")
			}
		}
	}
	if variable && (generatedName("param", target) || arrays[t.Symbol] && target == "param") {
		for uri := range parameterScopes {
			if old.Kind == "global" && affected[uri] || uri == old.Location.URI {
				return nil, errors.New("that name overlaps subroutine parameter variables")
			}
		}
	}
	if old.Kind == "local" && generatedName("param", old.Name) && parameterScopes[old.Location.URI] {
		return nil, errors.New("this name overlaps an implicit runtime variable; rename it manually")
	}
	edit := &WorkspaceEdit{Changes: make(map[string][]TextEdit)}
	for _, ref := range refs {
		edit.Changes[ref.URI] = append(edit.Changes[ref.URI], TextEdit{ref.Range, name})
	}
	return edit, nil
}
func markdown(value string) map[string]string {
	return map[string]string{"kind": "markdown", "value": value}
}
func (p *Project) Hover(doc uint32, position Position) any {
	t := p.TokenAt(doc, position)
	if t == nil {
		return nil
	}
	d := p.Documents[doc]
	if t.Type == Keyword && int(position.Line)+1 < d.widthCount() {
		c := p.names.Names[d.node(position.Line+1).Command]
		if c != "" {
			docs := CommandDocs[c]
			if docs == "" {
				docs = "ChoiceScript command."
			}
			return map[string]any{"contents": markdown("**`*" + c + "`**\n\n" + docs)}
		}
	}
	if t.Symbol == 0 {
		kind := ""
		switch t.Type {
		case Variable:
			kind = "unknown"
		case NumberVariable:
			kind = "number"
		case StringVariable:
			kind = "string"
		case BooleanVariable:
			kind = "boolean"
		}
		if kind == "" {
			return nil
		}
		return map[string]any{"contents": markdown("**Variable**\n\nType: `" + kind + "`")}
	}
	s := p.Symbols[t.Symbol]
	value := "**" + s.Name + "** — " + s.Kind
	var types []string
	switch t.Type {
	case StringVariable:
		types = []string{"string"}
	case NumberVariable:
		types = []string{"number"}
	case BooleanVariable:
		types = []string{"boolean"}
	case Variable:
		types = []string{"unknown"}
	default:
		types = typeNames(p.SymbolValues[t.Symbol])
	}
	if len(types) > 0 {
		value += "\n\nType: `" + strings.Join(types, " | ") + "`"
	}
	return map[string]any{"contents": markdown(value)}
}

type Completion struct {
	Label         string `json:"label"`
	Kind          uint8  `json:"kind"`
	InsertText    string `json:"insertText,omitempty"`
	Detail        string `json:"detail,omitempty"`
	Documentation any    `json:"documentation,omitempty"`
}

var commandPrefix = regexp.MustCompile(`^\s*\*\w*$`)
var scenePrefix = regexp.MustCompile(`\*(?:goto_scene|gosub_scene|redirect_scene)\s+\w*$`)
var labelPrefix = regexp.MustCompile(`\*(?:goto|gosub)\s+\w*$`)
var substitutionPrefix = regexp.MustCompile(`[$@]!{0,2}\{[^}]*$`)

func (p *Project) Completions(doc uint32, position Position, prefix string) []Completion {
	return p.completions(doc, position, commandPrefix.MatchString(prefix), scenePrefix.MatchString(prefix), labelPrefix.MatchString(prefix), substitutionPrefix.MatchString(prefix))
}

// CompletionsReader uses the same exact patterns on bounded source readers.
// Each reader starts at the physical line's beginning and stops at the cursor;
// the host can serve disk-backed scenes without allocating their entire text.
func (p *Project) CompletionsReader(doc uint32, position Position, read func() io.RuneReader) []Completion {
	return p.completions(doc, position, commandPrefix.MatchReader(read()), scenePrefix.MatchReader(read()), labelPrefix.MatchReader(read()), substitutionPrefix.MatchReader(read()))
}
func (p *Project) completions(doc uint32, position Position, commands, scenes, labels, substitution bool) []Completion {
	result := []Completion{}
	if commands {
		names := make([]string, 0, len(CommandDocs))
		for name := range CommandDocs {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			result = append(result, Completion{Label: "*" + name, Kind: 14, InsertText: name, Documentation: markdown(CommandDocs[name])})
		}
		return result
	}
	d := p.Documents[doc]
	code := int(position.Line)+1 < d.widthCount() && d.node(position.Line+1).Kind == command || substitution
	for id, s := range p.Symbols {
		switch {
		case scenes && s.Kind == "scene":
			result = append(result, Completion{Label: s.Name, Kind: 17})
		case labels && s.Kind == "label" && s.Location.URI == d.URI:
			result = append(result, Completion{Label: s.Name, Kind: 18})
		case !scenes && !labels && code && (s.Kind == "global" || s.Kind == "local" && s.Location.URI == d.URI):
			detail := strings.Join(typeNames(p.SymbolValues[id]), " | ")
			if detail == "" {
				detail = s.Kind
			}
			result = append(result, Completion{Label: s.Name, Kind: 6, Detail: detail})
		}
	}
	return result
}
func (p *Project) DocumentSymbols(doc uint32) []map[string]any {
	result := []map[string]any{}
	uri := p.Documents[doc].URI
	for _, s := range p.Symbols {
		if s.Kind != "" && s.Kind != "scene" && s.Location.URI == uri {
			kind := 13
			if s.Kind == "label" {
				kind = 12
			}
			result = append(result, map[string]any{"name": s.Name, "kind": kind, "range": s.Location.Range, "selectionRange": s.Location.Range})
		}
	}
	return result
}
func (p *Project) Folding(doc uint32) []map[string]any {
	d := p.Documents[doc]
	ends := make([]uint32, d.widthCount())
	for i := uint32(d.widthCount() - 1); i > 0; i-- {
		if ends[i] < i {
			ends[i] = i
		}
		if parent := d.node(i).Parent; parent != 0 && ends[i] > ends[parent] {
			ends[parent] = ends[i]
		}
	}
	result := []map[string]any{}
	for i := uint32(1); i < uint32(d.widthCount()); i++ {
		if ends[i] > i {
			kind := "region"
			if d.node(i).Kind == comment {
				kind = "comment"
			}
			result = append(result, map[string]any{"startLine": i - 1, "endLine": ends[i] - 1, "kind": kind})
		}
	}
	return result
}

type SelectionRange struct {
	Range  Range           `json:"range"`
	Parent *SelectionRange `json:"parent,omitempty"`
}

func (p *Project) Selections(doc uint32, positions []Position) []SelectionRange {
	d := p.Documents[doc]
	last := uint32(d.widthCount() - 2)
	full := SelectionRange{Range: Range{Position{}, Position{last, d.widthAt(last + 1)}}}
	result := make([]SelectionRange, 0, len(positions))
	for _, position := range positions {
		parent := SelectionRange{Range: full.Range, Parent: &full}
		if position.Line <= last {
			parent.Range = Range{Position{position.Line, 0}, Position{position.Line, d.widthAt(position.Line + 1)}}
		}
		if token := p.TokenAt(doc, position); token != nil {
			result = append(result, SelectionRange{tokenRange(*token, false), &parent})
		} else {
			result = append(result, parent)
		}
	}
	return result
}
func (p *Project) EncodeTokens(doc uint32) []uint32 {
	tokens := p.TokenSequence(doc)
	data := make([]uint32, 0, tokens.Len()*5)
	var previousLine, previousColumn uint32
	for _, token := range tokens.All() {
		delta := token.Line - previousLine
		column := token.Start
		if delta == 0 {
			column -= previousColumn
		}
		data = append(data, delta, column, token.Length, uint32(token.Type), uint32(token.Modifiers))
		previousLine = token.Line
		previousColumn = token.Start
	}
	return data
}
func (p *Project) WordCount(doc uint32) uint64 {
	d := p.Documents[doc]
	if d.wordMetrics != nil {
		return d.wordMetrics.total
	}
	var words uint64
	for _, count := range d.WordCounts {
		words += uint64(count)
	}
	return words
}
