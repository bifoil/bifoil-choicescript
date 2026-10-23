package core

import (
	"fmt"
	"strings"
)

const mixedScope = ^uint32(0)

// Observed token facts replace per-line environment snapshots. Full flow still
// carries its complete environment; display keeps only each reference's value
// and binding scope. Narrative substitutions separately retain their quote facts.
func (p *Project) recordRowTokens(d *Document, n *row, root uint32, expressionValue Value) {
	index := d.Scope - 1
	c := p.names.Names[n.Command]
	parameter := 0
	for id := n.TokenStart; id < n.TokenStart+n.TokenCount; id++ {
		t := d.Syntax[id]
		if t.Type == Label && t.Modifiers&declared == 0 && strings.HasSuffix(c, "_scene") && id != n.TargetToken {
			target, _, _ := p.jump(d, *n, root, c)
			symbol := mixedScope
			if uint32(target) != 0 {
				if found := p.labelNodes[target]; found != 0 {
					symbol = found
				}
			}
			prior := p.tokenScopes[index][id]
			if prior == 0 {
				p.tokenScopes[index][id] = symbol
			} else if prior != symbol {
				p.tokenScopes[index][id] = mixedScope
			}
		}
		if t.Type != Variable {
			continue
		}
		name := d.TokenName[id]
		var value Value
		var scope uint32
		expression := d.TokenExpr[id]
		if expression != 0 {
			if expression == n.Expr {
				value = expressionValue
			} else {
				value = p.eval(d, expression, root)
			}
			scope = p.variableScope(d, id, root)
		} else if p.arrayReferences[uint64(d.Scope)<<32|uint64(id)] {
			value = UnknownType
			scope = p.variableScope(d, id, root)
		} else if t.Modifiers&declared != 0 && n.Expr != 0 {
			value = expressionValue
			scope = p.variableScope(d, id, root)
		} else {
			value, scope = p.lookupAndScope(root, d.Scope, name)
		}
		if t.Modifiers&declared != 0 && n.Expr != 0 {
			value = expressionValue
		}
		if t.Modifiers&declared != 0 && c == "temp" && n.Expr == 0 {
			value = UnknownType
		}
		if t.Modifiers&declared != 0 && c == "params" {
			value = p.arena.get(root, p.names.key(parameterScope, p.names.name(fmt.Sprint(parameter))))
			parameter++
			if value == 0 {
				value = UnknownType
			}
		}

		previous := p.tokenValues[index][id]
		if previous == 0 {
			p.tokenValues[index][id] = value
		} else {
			p.tokenValues[index][id] = p.values.join(previous, value)
		}

		oldScope := p.tokenScopes[index][id]
		if oldScope == 0 {
			p.tokenScopes[index][id] = scope
		} else if oldScope != scope {
			p.tokenScopes[index][id] = mixedScope
		}
	}
}

// A scalar called items is independent of items[1]. Resolve the runtime
// element's scope, then use the separate array declaration namespace for its base.
func (p *Project) variableScope(d *Document, id, root uint32) uint32 {
	name := d.TokenName[id]
	if p.arrayReferences[uint64(d.Scope)<<32|uint64(id)] {
		name = p.names.name(p.names.Names[name] + "_count")
	}
	if expression := d.TokenExpr[id]; expression != 0 && d.Exprs[expression].Kind == exArray {
		if address := p.assigned(d, row{TargetExpr: expression}, root); address != 0 {
			name = address
		}
	}
	return p.bindingScope(root, d.Scope, name)
}
func (p *Project) factSymbol(d *Document, t Token, id uint32) uint32 {
	return p.variableSymbol(d, t, id, p.tokenScopes[d.Scope-1][id])
}
func (p *Project) variableSymbol(d *Document, t Token, id, scope uint32) uint32 {
	if t.Modifiers&declared != 0 && t.Symbol != 0 {
		return t.Symbol
	}
	name := d.TokenName[id]
	if scope == mixedScope {
		p.markAmbiguousRename(d, name)
		return 0
	}
	indexed := p.arrayReferences[uint64(d.Scope)<<32|uint64(id)]
	if expression := d.TokenExpr[id]; expression != 0 {
		indexed = indexed || d.Exprs[expression].Kind == exArray
	}
	if !indexed {
		if scope != 0 {
			if symbol := p.symbols[key{scope - 1, name}]; symbol != 0 {
				return symbol
			}
		}
		if scope == 0 {
			local, global := p.symbols[key{d.Scope, name}], p.symbols[key{0, name}]
			if local != 0 && global == 0 {
				return local
			}
			if global != 0 && local == 0 {
				return global
			}
		}
	}
	base := elementBase(p.names.Names[name])
	if base == p.names.Names[name] && !indexed {
		return 0
	}
	baseID, exists := p.names.names[base]
	if !exists {
		return 0
	}
	if scope != 0 {
		return p.arrayDeclarations[key{scope - 1, baseID}]
	}
	local, global := p.arrayDeclarations[key{d.Scope, baseID}], p.arrayDeclarations[key{0, baseID}]
	if local != 0 && global == 0 {
		return local
	}
	if global != 0 && local == 0 {
		return global
	}
	return 0
}
func (p *Project) collectSymbolValues() {
	for _, d := range p.Documents {
		for id, t := range d.Syntax {
			if t.Type != Variable {
				continue
			}
			symbol := p.factSymbol(d, t, uint32(id))
			value := p.tokenValues[d.Scope-1][id]
			if symbol == 0 || value == 0 {
				continue
			}
			old := p.SymbolValues[symbol]
			if old == 0 {
				p.SymbolValues[symbol] = value
			} else {
				p.SymbolValues[symbol] = p.values.join(old, value)
			}
		}
	}
}
func (p *Project) renderVariable(d *Document, line, id uint32, t *Token) {
	n := d.rowAt(int(line))
	t.Symbol = p.factSymbol(d, *t, id)
	name := d.TokenName[id]
	if t.Symbol != 0 && p.arraySymbols[t.Symbol] && p.Symbols[t.Symbol].Name != p.names.Names[name] {
		t.ReferenceLength = uint32(len(p.Symbols[t.Symbol].Name))
	}
	value := p.tokenValues[d.Scope-1][id]
	if value == 0 && t.Modifiers&declared != 0 && n.Expr != 0 {
		value = p.eval(d, n.Expr, 0)
	}
	if value == 0 && t.Symbol != 0 {
		value = p.SymbolValues[t.Symbol]
	}
	switch value & 15 {
	case NumberType:
		t.Type = NumberVariable
	case StringType:
		t.Type = StringVariable
	case BoolType:
		t.Type = BooleanVariable
	}
}
func (p *Project) prepareSymbols() {
	p.unsafeRenames = make(map[uint32]bool)
	p.Symbols = []Symbol{{}}
	p.SymbolValues = []Value{0}
	p.symbols = make(map[key]uint32)
	p.labelSymbols = make(map[key]uint32)
	p.labelNodes = make(map[uint64]uint32)
	p.arraySymbols = make(map[uint32]bool)
	p.arrayDeclarations = make(map[key]uint32)
	p.arrayReferences = make(map[uint64]bool)
	p.parameterScenes = make(map[string]bool)
	p.SceneSymbols = make([]uint32, len(p.Documents))
	for index, d := range p.Documents {
		p.SceneSymbols[index] = uint32(len(p.Symbols))
		p.Symbols = append(p.Symbols, Symbol{d.Scene, "scene", Location{d.URI, Range{}}})
		p.SymbolValues = append(p.SymbolValues, 0)
		for _, line := range d.semanticRows() {
			n := d.rowAt(int(line))
			c := p.names.Names[n.Command]
			if c == "delete_array" && n.TargetToken != 0 {
				p.arrayReferences[uint64(d.Scope)<<32|uint64(n.TargetToken)] = true
			}
			kind := ""
			if c == "label" {
				kind = "label"
			}
			if strings.HasPrefix(c, "create") {
				kind = "global"
			}
			if strings.HasPrefix(c, "temp") || c == "params" {
				kind = "local"
			}
			if kind == "" {
				continue
			}
			if c == "params" {
				p.parameterScenes[d.URI] = true
				for id := n.TokenStart; id < n.TokenStart+n.TokenCount; id++ {
					if name := d.TokenName[id]; name != 0 {
						p.declare(d, line, id, kind, name)
					}
				}
			} else if n.TargetToken != 0 {
				symbol := p.declare(d, line, n.TargetToken, kind, n.Target, c == "create_array" || c == "temp_array")
				if c == "label" {
					p.labelNodes[nodeID(uint32(index), line)] = symbol
				}
				if c == "create_array" || c == "temp_array" {
					p.arraySymbols[symbol] = true
				}
			}
		}
	}
}
