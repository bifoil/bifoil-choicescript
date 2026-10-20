package core

// Environment absence is distinct from an unknown runtime value. A missing
// override inherits its virtual array default; an explicit deletion suppresses
// that default. Presence bits never enter expression constants or query values.
const (
	bindingMissing  Value = 1 << 31
	bindingDeleted  Value = 1 << 30
	bindingPresence       = bindingMissing | bindingDeleted
)

func (a *envArena) joinBinding(left, right Value) Value {
	if left == right {
		return left
	}
	if _, ok := a.values.arrayRanges(left); ok {
		return a.values.joinArrayRanges(left, right)
	}
	if _, ok := a.values.arrayRanges(right); ok {
		return a.values.joinArrayRanges(left, right)
	}
	flags := (left | right) & bindingPresence
	if left == 0 || right == 0 {
		flags |= bindingMissing
	}
	x, y := left&^bindingPresence, right&^bindingPresence
	value := x
	if value == 0 {
		value = y
	} else if y != 0 {
		value = a.values.join(x, y)
	}
	return value | flags
}
func (p *Project) scopedBinding(root uint32, b binding, local bool) (Value, bool) {
	id := b.global
	if local {
		id = b.local
	}
	raw := p.read(root, id)
	value := raw &^ bindingPresence
	missing := raw == 0 || raw&bindingMissing != 0
	absent := raw&bindingDeleted != 0
	if missing {
		wild := b.localWild
		if !local {
			wild = p.names.key(0, b.wildName)
		}
		fallback := p.read(root, wild)
		if fallback == 0 {
			fallback = p.virtualValue(root, b, local)
		}
		next := fallback &^ bindingPresence
		if value == 0 {
			value = next
		} else if next != 0 {
			value = p.values.join(value, next)
		}
		absent = absent || fallback == 0 || fallback&bindingPresence != 0
	}
	return value, absent
}
func (p *Project) localBinding(root uint32, b binding) (Value, bool) {
	if raw := p.read(root, b.local); raw != 0 && raw&bindingPresence == 0 {
		return raw, false
	}
	value, absent := p.scopedBinding(root, b, true)
	if absent && b.dynamicLocal != 0 && p.read(root, b.dynamicLocal) != 0 {
		if value == 0 {
			value = UnknownType
		} else {
			value = p.values.join(value, UnknownType)
		}
	}
	return value, absent
}
func (p *Project) globalBindingValue(root uint32, b binding) Value {
	if raw := p.read(root, b.global); raw != 0 && raw&bindingPresence == 0 {
		return raw
	}
	value, absent := p.scopedBinding(root, b, false)
	if absent {
		if value == 0 {
			return UnknownType
		}
		return p.values.join(value, UnknownType)
	}
	return value
}
func (p *Project) bindingScope(root, scope, name uint32) uint32 {
	b := p.binding(scope, name)
	if b.globalOnly {
		return 1
	}
	local, absent := p.localBinding(root, b)
	if local == 0 {
		return 1
	}
	if absent {
		return mixedScope
	}
	return scope + 1
}
func (p *Project) writeActive(root, scope, name uint32, value Value) uint32 {
	b := p.binding(scope, name)
	if b.globalOnly {
		return p.arena.set(root, b.global, value)
	}
	local, absent := p.localBinding(root, b)
	if local == 0 {
		return p.arena.set(root, b.global, value)
	}
	if !absent {
		return p.arena.set(root, b.local, value)
	}
	// An ambiguous address can update either binding. Retain both reachable
	// effects; a later read or rename must not invent a definite scope.
	root = p.arena.set(root, b.local, p.arena.joinBinding(p.arena.get(root, b.local), value))
	return p.arena.set(root, b.global, p.arena.joinBinding(p.arena.get(root, b.global), value))
}
func (p *Project) markAmbiguousRename(d *Document, name uint32) {
	if p.unsafeRenames == nil {
		p.unsafeRenames = make(map[uint32]bool)
	}
	mark := func(name uint32) {
		for _, scope := range []uint32{0, d.Scope} {
			if symbol := p.symbols[key{scope, name}]; symbol != 0 {
				p.unsafeRenames[symbol] = true
			}
			if symbol := p.arrayDeclarations[key{scope, name}]; symbol != 0 {
				p.unsafeRenames[symbol] = true
			}
		}
	}
	mark(name)
	spelling := p.names.Names[name]
	base := elementBase(spelling)
	if base != spelling {
		if id, ok := p.names.names[base]; ok {
			mark(id)
		}
	}
}

// Token observation needs both type and binding scope. Resolve them together so
// an optional local/global binding is not traversed and joined a second time.
func (p *Project) lookupAndScope(root, scope, name uint32) (Value, uint32) {
	if value := builtinType(p.names.Names[name]); value != 0 {
		return value, 1
	}
	// An immutable environment can be queried by expressions and token facts
	// many times. Reuse exact reads, checking every operand on collisions. The
	// arena clears this bounded table before any collected handle is reused.
	// Effect discovery must perform the reads so its dependency set stays exact.
	if p.observing || p.disableReadMemo || name == 0 {
		return p.lookupBindingAndScope(root, scope, name)
	}
	if p.arena.reads == nil {
		p.arena.reads = make([]bindingRead, 4096)
	}
	index := (root*2654435761 ^ scope*3266489917 ^ name*2246822519) & uint32(len(p.arena.reads)-1)
	memo := &p.arena.reads[index]
	if memo.name == name && memo.scope == scope && memo.root == root {
		return memo.value, memo.bindingScope
	}
	value, bindingScope := p.lookupBindingAndScope(root, scope, name)
	*memo = bindingRead{root, scope, name, value, bindingScope}
	return value, bindingScope
}

func (p *Project) lookupBindingAndScope(root, scope, name uint32) (Value, uint32) {
	b := p.binding(scope, name)
	if b.globalOnly {
		return p.globalBindingValue(root, b), 1
	}
	local, absent := p.localBinding(root, b)
	if !absent {
		return local, scope + 1
	}
	global := p.globalBindingValue(root, b)
	if local == 0 {
		return global, 1
	}
	return p.values.join(local, global), mixedScope
}
