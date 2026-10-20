package core

import "strings"

// The source inventory proves whether a name can have a scene-local binding.
// This skips repeated absent-local probes only when every local creation form is
// known. A local array affects its own family; unknown local creation disables the proof.
func (p *Project) prepareBindings() {
	p.localFamilies = make([]map[string]bool, len(p.Documents)+1)
	p.dynamicLocals = make([]bool, len(p.Documents)+1)
	for _, d := range p.Documents {
		for _, sourceRowIndex := range d.semanticRows() {
			n := d.rowAt(int(sourceRowIndex))
			c := p.names.Names[n.Command]
			if c == "script" {
				p.dynamicLocals[d.Scope] = true
			}
			if c == "temp_array" {
				if n.TargetExpr != 0 && d.Exprs[n.TargetExpr].Kind == exVariable {
					if p.localFamilies[d.Scope] == nil {
						p.localFamilies[d.Scope] = make(map[string]bool)
					}
					p.localFamilies[d.Scope][p.names.Names[d.Exprs[n.TargetExpr].Arg]] = true
				} else {
					p.dynamicLocals[d.Scope] = true
				}
			}
			if c == "temp" && (n.TargetExpr == 0 || d.Exprs[n.TargetExpr].Kind != exVariable) {
				p.dynamicLocals[d.Scope] = true
			}
		}
	}
	p.dynamicLocalName = p.names.name("$dynamic-locals")
	p.bindings = nil
}
func (p *Project) globalBinding(scope, name uint32) bool {
	if p.disableBindingProof || scope == 0 || int(scope) >= len(p.localFamilies) || p.dynamicLocals[scope] {
		return false
	}
	if p.symbols[key{scope, name}] != 0 {
		return false
	}
	spelling := p.names.Names[name]
	for family := range p.localFamilies[scope] {
		if spelling == family || strings.HasPrefix(spelling, family+"_") {
			return false
		}
	}
	if p.parameterScenes[p.Documents[scope-1].URI] && (spelling == "param_count" || strings.HasPrefix(spelling, "param_")) {
		return false
	}
	return true
}

// A numeric array suffix is removed as one family, matching nested subscripts.
// These original scans avoid regexp allocations in per-reference transfers.
func numericBase(text string) string {
	end := len(text)
	for end > 0 {
		separator := strings.LastIndexByte(text[:end], '_')
		if separator < 0 || separator+1 == end {
			break
		}
		numeric := true
		for i := separator + 1; i < end; i++ {
			if text[i] < '0' || text[i] > '9' {
				numeric = false
				break
			}
		}
		if !numeric {
			break
		}
		end = separator
	}
	return text[:end]
}
func elementBase(text string) string {
	if strings.HasSuffix(text, "_count") {
		return text[:len(text)-6]
	}
	return numericBase(text)
}
