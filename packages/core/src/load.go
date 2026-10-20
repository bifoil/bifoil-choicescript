package core

import "maps"

// ParsedSource is a detached scene parse. It allows independent files to parse
// concurrently without sharing mutable intern tables or retaining source prose.
type ParsedSource struct {
	document *Document
	names    registry
	values   valuePool
}

func ParseSource(source Source) *ParsedSource {
	result := new(ParsedSource)
	result.document = parseSource(source, 0, &result.names, &result.values)
	return result
}

// AddParsed remaps compact scene-local IDs into this project's canonical arenas.
// It transfers ownership: callers must not reuse the detached parse afterward.
func (p *Project) AddParsed(parsed *ParsedSource) *Document {
	d := parsed.document
	d.Scope = uint32(len(p.Documents) + 1)
	names := make([]uint32, len(parsed.names.Names))
	for id, name := range parsed.names.Names {
		names[id] = p.names.name(name)
	}
	values := make([]Value, len(parsed.values.entries))
	for id, value := range parsed.values.entries {
		if id != 0 {
			values[id] = p.values.literal(value)
		}
	}
	for _, index := range d.semanticRows() {
		row := d.rowAt(int(index))
		command, target := names[row.Command], names[row.Target]
		if command != row.Command || target != row.Target {
			row.Command, row.Target = command, target
			d.setRow(int(index), row)
		}
	}
	for id := range d.Exprs {
		e := &d.Exprs[id]
		switch e.Kind {
		case exVariable, exArray, exCall:
			e.Arg = names[e.Arg]
		case exLiteral:
			value := Value(e.Arg)
			if constant := value >> 4; constant != 0 {
				e.Arg = uint32(values[constant])
			}
		}
	}
	for token, name := range d.TokenName {
		d.TokenName[token] = names[name]
	}
	p.Documents = append(p.Documents, d)
	parsed.document = nil
	parsed.names = registry{}
	parsed.values = valuePool{}
	return d
}

// CloneForTransfer separates the arrays/maps that project ID remapping or later
// analysis can mutate. The original detached parse remains safe to serialize in
// a bounded cache worker; source strings and other immutable arenas stay shared.
func (p *ParsedSource) CloneForTransfer() *ParsedSource {
	copy := *p
	document := *p.document
	document.Rows = append([]row(nil), document.Rows...)
	document.cloneSourceRows()
	document.Exprs = append([]expr(nil), document.Exprs...)
	document.Syntax = append([]Token(nil), document.Syntax...)
	if document.TokenName != nil {
		names := make(map[uint32]uint32, len(document.TokenName))
		maps.Copy(names, document.TokenName)
		document.TokenName = names
	}
	copy.document = &document
	return &copy
}
