package core

import (
	"context"
	"math"
	"strconv"
	"strings"
)

// A homogeneous initializer is an immutable virtual default, independent of the
// summary used for unknown-index reads. Explicit element writes override it.
// Storage depends on source and writes, not on a potentially enormous count.
func (p *Project) bindVirtual(scope, name uint32, b *binding) {
	if len(p.arrayBases) == 0 {
		return
	}
	spelling := p.names.Names[name]
	separator := strings.LastIndexByte(spelling, '_')
	if separator < 0 {
		return
	}
	suffix := spelling[separator+1:]
	if suffix == "" || suffix[0] == '0' {
		return
	}
	for i := range suffix {
		if suffix[i] < '0' || suffix[i] > '9' {
			return
		}
	}
	index, err := strconv.ParseUint(suffix, 10, 64)
	if err != nil || index == 0 {
		return
	}
	base, ok := p.names.names[spelling[:separator]]
	if !ok || !p.arrayBases[base] {
		return
	}
	defaultName := p.names.name(spelling[:separator] + "_$default")
	countName := p.names.name(spelling[:separator] + "_count")
	b.defaults = [4]uint32{p.names.key(scope, defaultName), p.names.key(0, defaultName), p.names.key(scope, countName), p.names.key(0, countName)}
	b.index = index
}
func (p *Project) virtualValue(root uint32, b binding, local bool) Value {
	if b.defaults[0] == 0 {
		return 0
	}
	i := 0
	if !local {
		i = 1
	}
	return p.values.arrayValue(p.read(root, b.defaults[i]), b.index)
}
func (p *Project) indexMayNameCount(d *Document, n row, root uint32) bool {
	if n.TargetExpr == 0 {
		return true
	}
	e := d.Exprs[n.TargetExpr]
	if e.Kind != exArray {
		return true
	}
	for _, id := range d.Args[e.A : e.A+e.B] {
		if value := p.eval(d, id, root); value&(StringType|UnknownType) != 0 {
			return true
		}
	}
	return false
}

// A numeric member is exactly base_N. Nested and named properties are ordinary
// independent variables and are not removed by delete_array.
func numericArrayMember(base, name string) (uint64, bool) {
	if len(name) <= len(base)+1 || !strings.HasPrefix(name, base) || name[len(base)] != '_' {
		return 0, false
	}
	suffix := name[len(base)+1:]
	if suffix == "" || suffix[0] == '0' {
		return 0, false
	}
	for i := range suffix {
		if suffix[i] < '0' || suffix[i] > '9' {
			return 0, false
		}
	}
	index, err := strconv.ParseUint(suffix, 10, 64)
	return index, err == nil && index != 0
}

// Index each newly interned binding once. Scanning a whole environment at every
// array declaration makes a game with many small arrays quadratic in all stats.
// This index retains all matching keys, including dynamically generated ones.
func (p *Project) arrayMembers(scope uint32, base string) []uint32 {
	for p.arrayKeysScanned < len(p.names.Keys) {
		id := uint32(p.arrayKeysScanned)
		p.arrayKeysScanned++
		k := p.names.Keys[id]
		spelling := p.names.Names[k.Name]
		for end := len(spelling); end > 0; {
			separator := strings.LastIndexByte(spelling[:end], '_')
			if separator < 0 {
				break
			}
			if family, ok := p.names.names[spelling[:separator]]; ok {
				key := key{k.Scope, family}
				p.arrayKeys[key] = append(p.arrayKeys[key], id)
			}
			end = separator
		}
	}
	return p.arrayKeys[key{scope, p.names.name(base)}]
}
func (p *Project) clearArrayPrefix(root, scope uint32, base string, count uint64) uint32 {
	for _, id := range p.arrayMembers(scope, base) {
		k := p.names.Keys[id]
		if index, ok := numericArrayMember(base, p.names.Names[k.Name]); ok && index <= count && p.arena.get(root, id) != 0 {
			root = p.arena.set(root, id, 0)
		}
	}
	return root
}
func (p *Project) arrayNumericSummary(root, scope uint32, base string) Value {
	result := Value(0)
	merge := func(value Value) {
		value &^= bindingPresence
		if value == 0 {
			return
		}
		if result == 0 {
			result = value
		} else {
			result = p.values.join(result, value)
		}
	}
	domain := p.arena.get(root, p.names.key(scope, p.names.name(base+"_$default")))
	if ranges, ok := p.values.arrayRanges(domain); ok {
		for index := 0; index < len(ranges); index += arrayRangeWidth {
			merge(arrayRangeValue(ranges, index))
		}
	} else {
		merge(domain)
	}
	for _, id := range p.arrayMembers(scope, base) {
		if _, ok := numericArrayMember(base, p.names.Names[p.names.Keys[id].Name]); ok {
			merge(p.arena.get(root, id))
		}
	}

	return result
}
func (p *Project) defineArray(ctx context.Context, d *Document, n row, root uint32, local bool) (uint32, error) {
	scope := uint32(0)
	if local {
		scope = d.Scope
	}
	base := p.names.Names[n.Target]
	refs := d.Args[n.ExprStart : n.ExprStart+n.ExprCount]
	length := UnknownType
	if len(refs) > 0 {
		length = p.eval(d, refs[0], root)
	}
	count := ^uint64(0)
	if size, ok := p.values.constant(length &^ bindingPresence); ok && Value(size.Kind) == NumberType && size.Number >= 1 && size.Number == math.Floor(size.Number) && size.Number < math.Exp2(64) {
		count = uint64(size.Number)
	}
	defaultID := p.names.key(scope, p.names.name(base+"_$default"))
	previous := p.arena.get(root, defaultID)
	var replacements []arrayRange
	if len(refs) <= 2 {
		value := UnknownType
		if len(refs) == 2 {
			value = p.bindingValue(n.Target, p.eval(d, refs[1], root))
		}
		replacements = []arrayRange{{count, value}}
	} else {
		// The interpreter writes each value before evaluating the next one. In
		// particular, _count still has its old value during every initializer.
		for index, id := range refs[1:] {
			if uint64(index) >= count {
				break
			}
			if index&255 == 0 {
				if err := ctx.Err(); err != nil {
					return root, err
				}
				if p.arena.needsCollection() {
					p.transient = root
					p.collect()
				}
			}
			value := p.bindingValue(n.Target, p.eval(d, id, root))
			last := uint64(index + 1)
			if len(replacements) > 0 && replacements[len(replacements)-1].value == value {
				replacements[len(replacements)-1].last = last
			} else {
				replacements = append(replacements, arrayRange{last, value})
			}
			member := p.names.name(base + "_" + strconv.Itoa(index+1))
			root = p.arena.set(root, p.names.key(scope, member), value)
		}
		if len(replacements) == 0 || replacements[len(replacements)-1].last < count {
			replacements = append(replacements, arrayRange{count, UnknownType})
		}
	}
	root = p.clearArrayPrefix(root, scope, base, count)
	root = p.arena.set(root, defaultID, p.values.replaceArrayPrefix(previous, replacements, count))
	// _count is a real independent variable and is assigned last, exactly once.
	root = p.arena.set(root, p.names.key(scope, p.names.name(base+"_count")), length)
	root = p.arena.set(root, p.names.key(scope, p.names.name(base+"_*")), p.arrayNumericSummary(root, scope, base))
	return root, nil
}
func (p *Project) deleteArray(d *Document, name, root uint32) uint32 {
	base := p.names.Names[name]
	countName := p.names.name(base + "_count")
	if p.bindingScope(root, d.Scope, countName) == mixedScope {
		// Either branch may supply the active _count. Compute both complete effects
		// from the same input; a sibling must never inherit the other's deletion.
		local := p.deleteArrayScope(root, d.Scope, base, countName)
		global := p.deleteArrayScope(root, 0, base, countName)
		return p.arena.join(local, global)
	}
	scope := p.names.Keys[p.active(root, d.Scope, countName)].Scope
	return p.deleteArrayScope(root, scope, base, countName)
}
func (p *Project) deleteArrayScope(root, scope uint32, base string, countName uint32) uint32 {
	length := p.arena.get(root, p.names.key(scope, countName))
	count := ^uint64(0)
	exact := false
	if size, ok := p.values.constant(length &^ bindingPresence); ok && Value(size.Kind) == NumberType && !math.IsNaN(size.Number) && !math.IsInf(size.Number, 0) && size.Number < math.Exp2(64) {
		count = 0
		if size.Number > 0 {
			count = uint64(math.Floor(size.Number))
		}
		exact = true
	}
	defaultID := p.names.key(scope, p.names.name(base+"_$default"))
	old := p.arena.get(root, defaultID)
	if exact {
		root = p.clearArrayPrefix(root, scope, base, count)
		if count != 0 {
			root = p.arena.set(root, defaultID, p.values.replaceArrayPrefix(old, []arrayRange{{count, 0}}, count))
		}
	} else {
		// Unknown lengths may delete any numeric prefix. Keep every surviving type
		// and optional presence instead of inventing either a full deletion or reset.
		if _, ok := p.values.arrayRanges(old); ok {
			root = p.arena.set(root, defaultID, p.values.joinArrayRanges(old, 0))
		}
		for _, id := range p.arrayMembers(scope, base) {
			if _, ok := numericArrayMember(base, p.names.Names[p.names.Keys[id].Name]); ok {
				value := p.arena.get(root, id)
				if value != 0 {
					root = p.arena.set(root, id, p.arena.joinBinding(value, bindingDeleted))
				}
			}
		}

	}
	root = p.arena.set(root, p.names.key(scope, countName), bindingDeleted)
	return p.arena.set(root, p.names.key(scope, p.names.name(base+"_*")), p.arrayNumericSummary(root, scope, base))
}

type arrayReadMemo struct {
	root, scope, base uint32
	value             Value
}

// Weak, bounded memoization shares exact family reads for one immutable root.
// Environment collection clears it before numeric handles can be reused. The
// observational reference path bypasses it to retain every read dependency.
func (p *Project) anyArrayValue(root, scope uint32, base string) Value {
	baseID := p.names.name(base)
	slot := (root*0x9e3779b9 ^ scope*0x85ebca6b ^ baseID*0xc2b2ae35) & 16383
	if !p.observing {
		if len(p.arrayReads) == 0 {
			p.arrayReads = make([]arrayReadMemo, 16384)
		}
		prior := p.arrayReads[slot]
		if prior.root == root && prior.scope == scope && prior.base == baseID && prior.value != 0 {
			return prior.value
		}
	}
	result := p.computeAnyArrayValue(root, scope, base)
	if !p.observing {
		p.arrayReads[slot] = arrayReadMemo{root, scope, baseID, result}
	}
	return result
}
func (p *Project) computeAnyArrayValue(root, scope uint32, base string) Value {
	result := Value(0)
	// The member pass below includes every explicit numeric and named binding.
	// Only virtual defaults need a separate read; scanning all numeric members
	// here as well would evaluate the same family twice per expression.
	for _, currentScope := range []uint32{0, scope} {
		domain := p.read(root, p.names.key(currentScope, p.names.name(base+"_$default")))
		merge := func(value Value) {
			value &^= bindingPresence
			if value == 0 {
				return
			}
			if result == 0 {
				result = value
			} else {
				result = p.values.join(result, value)
			}
		}
		if ranges, ok := p.values.arrayRanges(domain); ok {
			for index := 0; index < len(ranges); index += arrayRangeWidth {
				merge(arrayRangeValue(ranges, index))
			}
		} else {
			merge(domain)
		}
	}

	// A string subscript can resolve _count or any named/nested variable. Do not
	// assume that arrays declared elsewhere enumerate the complete namespace.
	for _, currentScope := range []uint32{0, scope} {
		for _, id := range p.arrayMembers(currentScope, base) {
			k := p.names.Keys[id]
			text := p.names.Names[k.Name]
			if p.arena.get(root, id) == 0 || strings.ContainsAny(text[len(base)+1:], "$*") {
				continue
			}
			value := p.lookup(root, scope, k.Name)
			if result == 0 {
				result = value
			} else {
				result = p.values.join(result, value)
			}
		}
	}

	if result == 0 {
		return UnknownType
	}
	return result
}

func (p *valuePool) weakArrayWrite(previous, value Value) Value {
	ranges, ok := p.arrayRanges(previous)
	if !ok {
		if previous&^bindingPresence == 0 {
			return previous
		}
		return p.join(previous&^bindingPresence, value) | (previous & bindingPresence)
	}
	var result []byte
	for index := 0; index < len(ranges); index += arrayRangeWidth {
		old := arrayRangeValue(ranges, index)
		next := old
		if old&^bindingPresence != 0 {
			next = p.join(old&^bindingPresence, value) | (old & bindingPresence)
		}
		result = appendArrayRange(result, arrayRangeEnd(ranges, index), next)
	}
	return p.internArrayRanges(result)
}
func (p *Project) writeUnknownArray(d *Document, n row, root uint32, base string, value Value) uint32 {
	mayNameFields := p.indexMayNameCount(d, n, root)
	// A dynamic address may resolve a local numeric element or an independent
	// global named property. Resolve each existing variable's actual scope rather
	// than choosing the whole family from its base or wildcard summary.
	for _, scope := range []uint32{0, d.Scope} {
		for _, id := range p.arrayMembers(scope, base) {
			name := p.names.Keys[id].Name
			suffix := p.names.Names[name][len(base)+1:]
			if strings.ContainsAny(suffix, "$*") || !mayNameFields && (!arraySuffix.MatchString(suffix) || suffix == "count") || p.arena.get(root, id) == 0 {
				continue
			}
			prior := p.lookup(root, d.Scope, name)
			root = p.writeActive(root, d.Scope, name, p.values.join(prior, value))
		}
	}
	for _, scope := range []uint32{0, d.Scope} {
		id := p.names.key(scope, p.names.name(base+"_$default"))
		if old := p.arena.get(root, id); old != 0 {
			root = p.arena.set(root, id, p.values.weakArrayWrite(old, value))
		}
		summary := p.names.key(scope, p.names.name(base+"_*"))
		if p.arena.get(root, summary) != 0 {
			root = p.arena.set(root, summary, p.arrayNumericSummary(root, scope, base))
		}
	}
	return root
}
