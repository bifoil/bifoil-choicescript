package core

import "strconv"

func parameterAlias(i int) string { return "param_" + strconv.Itoa(i) }

// replace copies precisely the selected bindings from right, including absent
// bindings (deletions). Entire selected or untouched subtrees remain shared.
// Unlike a lattice join this is assignment, so it preserves callee writes.
func (a *envArena) replace(left, right uint32, mask *keyMask) uint32 {
	if left == right {
		return left
	}
	if result, ok := a.memoLookup(left, right, mask, 2); ok {
		return result
	}
	return a.memoStore(left, right, mask, 2, a.replaceUncached(left, right, mask))
}
func (a *envArena) replaceUncached(left, right uint32, mask *keyMask) uint32 {
	var level uint8
	if left != 0 {
		level = a.page(left).Level
	}
	if right != 0 {
		level = max(level, a.page(right).Level)
	}
	return a.normalize(a.replaceAt(left, right, mask, 0, level))
}
func (a *envArena) replaceAt(left, right uint32, mask *keyMask, prefix uint32, level uint8) uint32 {
	if left == right {
		return left
	}
	index := prefix >> (envShift * (uint32(level) + 1))
	row := mask.levels[level]
	if int(index) >= len(row.any) || row.any[index] == 0 {
		return left
	}
	if row.all[index] == envAllSlots {
		return right
	}
	var slots [envFanout]uint32
	var count uint32
	var classes uint8
	sameLeft := left == 0 || a.page(left).Level == level
	sameRight := right == 0 || a.page(right).Level == level
	for i := range slots {
		x, y := a.child(left, i, level), a.child(right, i, level)
		bit := uint16(1) << i
		value := x
		key := prefix | uint32(i)<<(envShift*level)
		if row.all[index]&bit != 0 {
			value = y
		} else if level > 0 && row.any[index]&bit != 0 {
			value = a.replaceAt(x, y, mask, key, level-1)
		}
		slots[i] = value
		sameLeft = sameLeft && value == x
		sameRight = sameRight && value == y
		if level > 0 {
			count += a.size(value)
			classes |= a.class(value)
		} else if value != 0 {
			count++
			classes |= a.keyClass(key)
		}
	}
	if sameLeft {
		return left
	}
	if sameRight {
		return right
	}
	if count == 0 {
		return 0
	}
	result := a.allocate(level)
	a.page(result).Slots, a.page(result).Size, a.page(result).Classes = slots, count, classes
	for i, value := range slots {
		a.page(result).Hash ^= environmentSlotHash(value, uint32(i))
	}
	return a.intern(result)
}

func (p *Project) returnMask(e *callEffects) *keyMask {
	if e.outputMask == nil {
		e.outputMask = new(keyMask)
	}
	m := e.outputMask
	if !m.initialized || m.arguments < p.maximumArguments {
		for id := range e.written {
			m.add(id)
		}
		for _, scope := range e.parameters {
			m.add(p.names.key(scope, p.names.name("param_count")))
			for i := 1; i <= p.maximumArguments; i++ {
				m.add(p.names.key(scope, p.names.name(parameterAlias(i))))
			}
		}
		m.arguments = p.maximumArguments
		m.initialized = true
	}
	for id := max(uint32(1), m.indexed); id < uint32(len(p.names.Keys)); id++ {
		if p.names.Keys[id].Scope == parameterScope || p.effectArray(e.writtenArrays, id) || p.effectArray(e.wideWrittenArrays, id) {
			m.add(id)
		}
	}
	m.indexed = uint32(len(p.names.Keys))
	return m
}
func (p *Project) frameMask(scope uint32) *keyMask {
	if p.frames == nil {
		p.frames = make(map[uint32]*keyMask)
	}
	m := p.frames[scope]
	if m == nil {
		m = new(keyMask)
		p.frames[scope] = m
	}
	for id := max(uint32(1), m.indexed); id < uint32(len(p.names.Keys)); id++ {
		s := p.names.Keys[id].Scope
		if s == scope || s == parameterScope {
			m.add(id)
		}
	}
	m.indexed = uint32(len(p.names.Keys))
	return m
}
