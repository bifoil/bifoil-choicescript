package core

import (
	"fmt"
	"slices"
	"strings"
)

// Array subscripts can name any suffix, including strings and nested properties.
// A family mask retains every matching binding; it never assumes numeric-only
// storage when a dynamic string address can cross the rest of the namespace.
func (p *Project) effectArray(prefixes map[key]bool, id uint32) bool {
	if len(prefixes) == 0 {
		return false
	}
	k := p.names.Keys[id]
	text := p.names.Names[k.Name]
	for end := len(text); end > 0; {
		separator := strings.LastIndexByte(text[:end], '_')
		if separator < 0 {
			return false
		}
		if name, ok := p.names.names[text[:separator]]; ok && prefixes[key{k.Scope, name}] {
			return true
		}
		end = separator
	}
	return false
}
func (e *callEffects) addArray(family key, writes bool) {
	if e.arrays == nil {
		e.arrays = make(map[key]bool)
	}
	e.arrays[family] = true
	if writes {
		if e.writtenArrays == nil {
			e.writtenArrays = make(map[key]bool)
		}
		e.writtenArrays[family] = true
	}
}

// Effects include reachable nested callees and their continuations. Unresolvable
// indirection keeps the entire input; it never discards analysis or guesses writes.
func (p *Project) calleeEffects(target uint64, argument uint32, args []Value) *callEffects {
	cacheKey := effectKey{target, argument}
	if cached, ok := p.effects[cacheKey]; ok {
		return cached
	}
	p.effects[cacheKey] = nil
	if result := p.straightEffects(target, args); result != nil {
		p.effects[cacheKey] = result
		return result
	}
	frame := p.stableRoutineFrame(target, args)
	result := &callEffects{needed: make(map[uint32]bool), written: make(map[uint32]bool)}
	result.needed[p.names.key(p.Documents[uint32(target>>32)].Scope, p.dynamicLocalName)] = true
	pending := []uint64{target}
	visited := make(map[uint64]bool)
	for len(pending) > 0 {
		id := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if visited[id] {
			continue
		}
		visited[id] = true
		doc, line := uint32(id>>32), uint32(id)
		d := p.Documents[doc]
		n := d.rowAt(int(line))
		c := p.names.Names[n.Command]
		if c == "script" {
			return nil
		}
		add := func(name uint32, writes bool, scope int64) {
			scopes := []uint32{0, d.Scope}
			if scope >= 0 {
				scopes = []uint32{uint32(scope)}
			}
			for _, s := range scopes {
				key := p.names.key(s, name)
				result.needed[key] = true
				if writes {
					result.written[key] = true
				}
			}
		}
		array := func(name uint32, writes bool, scope int64) {
			scopes := []uint32{0, d.Scope}
			if scope >= 0 {
				scopes = []uint32{uint32(scope)}
			}
			for _, s := range scopes {
				k := key{s, name}
				result.addArray(k, writes)
			}
		}
		for token := n.TokenStart; token < n.TokenStart+n.TokenCount; token++ {
			if name := d.TokenName[token]; name != 0 {
				add(name, false, -1)
				add(p.names.name(p.names.Names[name]+"_*"), false, -1)
				base := elementBase(p.names.Names[name])
				if base != p.names.Names[name] {
					add(p.names.name(base), false, -1)
					add(p.names.name(base+"_*"), false, -1)
				}
				if expression := d.TokenExpr[token]; expression != 0 {
					array(d.Exprs[expression].Arg, false, -1)
				}
			}
		}
		if !p.inspectEffectRow(d, line, n, frame, result) {
			return nil
		}
		writtenName := n.Target
		if c == "setref" {
			writtenName = p.frameAddress(d, n.TargetExpr, frame)
			if writtenName == 0 {
				return nil
			}
		} else if n.TargetExpr != 0 && d.Exprs[n.TargetExpr].Kind == exIndirect {
			writtenName = p.frameAddress(d, d.Exprs[n.TargetExpr].A, frame)
			if writtenName == 0 {
				return nil
			}
		}
		switch c {
		case "create", "temp", "set", "setref", "rand", "input_text", "input_number", "delete":
			if writtenName == 0 {
				break
			}
			scope := int64(-1)
			if c == "create" {
				scope = 0
			}
			if c == "temp" {
				scope = int64(d.Scope)
			}
			if n.TargetExpr != 0 && d.Exprs[n.TargetExpr].Kind == exArray {
				array(d.Exprs[n.TargetExpr].Arg, true, scope)
				if result.wideWrittenArrays == nil {
					result.wideWrittenArrays = make(map[key]bool)
				}
				for _, s := range []uint32{0, d.Scope} {
					if scope < 0 || uint32(scope) == s {
						result.wideWrittenArrays[key{s, d.Exprs[n.TargetExpr].Arg}] = true
					}
				}
			} else {
				add(writtenName, true, scope)
			}
			base := numericBase(p.names.Names[writtenName])
			if base != p.names.Names[writtenName] {
				add(p.names.name(base+"_*"), true, scope)
			}
		case "create_array", "temp_array", "delete_array":
			scope := int64(-1)
			if c == "create_array" {
				scope = 0
			}
			if c == "temp_array" {
				scope = int64(d.Scope)
			}
			array(n.Target, true, scope)
		case "params":
			result.parameters = append(result.parameters, d.Scope)
			for token := n.TokenStart; token < n.TokenStart+n.TokenCount; token++ {
				if name := d.TokenName[token]; name != 0 {
					add(name, true, int64(d.Scope))
				}
			}
		case "return", "ending", "abort", "restart":
			continue
		case "goto", "gotoref", "goto_scene", "redirect_scene", "gosub", "gosub_scene":
			next, _, _ := p.jump(d, n, 0, c)
			if uint32(next) == 0 || strings.HasSuffix(c, "_scene") && !strings.HasPrefix(c, "gosub") {
				return nil
			}
			pending = append(pending, next)
			if !strings.HasPrefix(c, "gosub") {
				continue
			}
		case "finish", "goto_random_scene":
			return nil
		}
		next := p.graphs[doc].targets(line)
		if len(next) == 0 {
			return nil
		}
		for _, line := range next {
			pending = append(pending, nodeID(doc, line))
		}
	}
	result.argumentCount = len(args)
	p.dropOverwrittenInputs(target, result)
	p.effects[cacheKey] = result
	return result
}
func (p *Project) projectCall(state flowState, effects *callEffects) flowState {
	if effects == nil {
		return state
	}
	if effects.mask == nil {
		effects.mask = new(keyMask)
	}
	mask := effects.mask
	add := func(id uint32) {
		if !effects.inputKilled[id] {
			mask.add(id)
		}
	}
	if !mask.initialized || mask.arguments < p.maximumArguments {
		for id := range effects.needed {
			add(id)
		}
		if !effects.noRegisters {
			add(p.names.key(parameterScope, p.names.name("count")))
			for i := 0; i < p.maximumArguments; i++ {
				add(p.names.key(parameterScope, p.names.name(fmt.Sprint(i))))
			}
		}
		for _, scope := range effects.parameters {
			add(p.names.key(scope, p.names.name("param_count")))
			for i := 1; i <= p.maximumArguments; i++ {
				add(p.names.key(scope, p.names.name(fmt.Sprintf("param_%d", i))))
			}
		}
		mask.arguments = p.maximumArguments
		mask.initialized = true
	}
	if len(effects.arrays) > 0 {
		for id := max(uint32(1), mask.indexed); id < uint32(len(p.names.Keys)); id++ {
			if p.effectArray(effects.arrays, id) {
				add(id)
			}
		}
	}
	mask.indexed = uint32(len(p.names.Keys))
	state.env = p.arena.normalize(p.arena.intersect(state.env, mask, 0))
	return state
}

// Values overwritten by a routine's unconditional prefix cannot affect any
// later execution of that routine. Remove only exact, explicitly assigned keys;
// array namespaces and ambiguous scope presence remain conservative.
func (p *Project) dropOverwrittenInputs(target uint64, effects *callEffects) {
	doc, line := uint32(target>>32), uint32(target)
	d := p.Documents[doc]
	read := make(map[uint32]bool)
	seen := make(map[uint32]bool)
	for line != 0 && !seen[line] {
		seen[line] = true
		n := d.rowAt(int(line))
		c := p.names.Names[n.Command]
		if c == "if" || c == "elseif" || c == "elsif" || c == "else" || c == "choice" || c == "fake_choice" || c == "selectable_if" || strings.HasPrefix(c, "goto") || strings.HasPrefix(c, "gosub") || c == "return" || c == "finish" || c == "ending" || c == "abort" || c == "restart" {
			return
		}
		for token := n.TokenStart; token < n.TokenStart+n.TokenCount; token++ {
			if token == n.TargetToken && declarationCommands[c] || c == "params" && d.Syntax[token].Modifiers&declared != 0 {
				continue
			}
			if name := d.TokenName[token]; name != 0 {
				read[name] = true
			}
		}
		if (c == "temp" || c == "create") && n.Expr != 0 && n.TargetExpr != 0 && d.Exprs[n.TargetExpr].Kind == exVariable && !read[n.Target] {
			scope := uint32(0)
			if c == "temp" {
				scope = d.Scope
			}
			delete(effects.needed, p.names.key(scope, n.Target))
		}
		if c == "params" {
			if effects.inputKilled == nil {
				effects.inputKilled = make(map[uint32]bool)
			}
			kill := func(name uint32) {
				if !read[name] {
					id := p.names.key(d.Scope, name)
					effects.inputKilled[id] = true
					delete(effects.needed, id)
				}
			}
			kill(p.names.name("param_count"))
			bound := 0
			for token := n.TokenStart; token < n.TokenStart+n.TokenCount; token++ {
				if name := d.TokenName[token]; name != 0 {
					kill(name)
					bound++
				}
			}
			for i := 1; i <= max(bound, effects.argumentCount); i++ {
				kill(p.names.name(fmt.Sprintf("param_%d", i)))
			}
		}
		next := p.graphs[doc].targets(line)
		if len(next) != 1 {
			return
		}
		line = next[0]
	}
}

func (p *Project) rowHasIndirectRead(d *Document, n row) bool {
	var indirect func(uint32) bool
	indirect = func(id uint32) bool {
		if id == 0 {
			return false
		}
		e := d.Exprs[id]
		switch e.Kind {
		case exIndirect:
			return true
		case exBinary:
			return indirect(e.A) || indirect(e.B)
		case exArray, exCall:
			if slices.ContainsFunc(d.Args[e.A:e.A+e.B], indirect) {
				return true
			}
		}
		return false
	}
	if indirect(n.Expr) {
		return true
	}
	for token := n.TokenStart; token < n.TokenStart+n.TokenCount; token++ {
		if indirect(d.TokenExpr[token]) {
			return true
		}
	}
	return slices.ContainsFunc(d.Args[n.ExprStart:n.ExprStart+n.ExprCount], indirect)
}
