package core

import "testing"

func TestBindingReadsRemainCurrentAfterHandleReuseAndEffectDiscovery(t *testing.T) {
	p := NewProject()
	name := p.names.name("score")
	p.arena = envArena{registry: &p.names, values: &p.values}
	binding := p.binding(1, name)
	root := p.arena.set(0, binding.global, NumberType)
	for range 3 {
		value, scope := p.lookupAndScope(root, 1, name)
		if value != NumberType || scope != 1 {
			t.Fatal("repeated global read changed value or scope")
		}
	}

	// The old state is dead. Reusing its numeric handle must never reuse its
	// former value, even when the same name and scene are queried again.
	p.arena.beginCollection()
	p.arena.endCollection()
	replacement := p.arena.set(0, binding.global, BoolType)
	if replacement != root {
		t.Fatal("fixture did not exercise a recycled environment handle")
	}
	value, scope := p.lookupAndScope(replacement, 1, name)
	if value != BoolType || scope != 1 {
		t.Fatal("collected environment returned obsolete reference facts")
	}

	// Discovering a call's effects must still record dependencies after the
	// same lookup was already served during ordinary type/token analysis.
	p.observing = true
	p.reads = 0
	if p.lookup(replacement, 1, name) != BoolType || p.arena.get(p.reads, binding.global) != BoolType {
		t.Fatal("reused reference facts hid a call dependency")
	}
}
