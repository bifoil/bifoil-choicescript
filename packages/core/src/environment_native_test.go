package core

import (
	"maps"
	"reflect"
	"testing"
)

func TestNativeEnvironmentSnapshotsAndCollection(t *testing.T) {
	var names registry
	var values valuePool
	keys := make([]uint32, 997)
	for i := range keys {
		keys[i] = names.key(0, names.name("variable_"+primitive{Number: float64(i), Kind: uint8(NumberType)}.string()))
	}
	arena := envArena{registry: &names}
	var root uint32
	expected := make(map[uint32]Value)
	type snapshot struct {
		root   uint32
		values map[uint32]Value
	}
	var saved []snapshot
	collections := 0
	for step := range 240000 {
		if step%7500 == 0 {
			copy := make(map[uint32]Value, len(expected))
			maps.Copy(copy, expected)
			saved = append(saved, snapshot{root, copy})
		}
		key := keys[(step*7919)%len(keys)]
		if step%7 == 0 {
			root = arena.set(root, key, 0)
			delete(expected, key)
		} else {
			value := values.number(float64(step))
			root = arena.set(root, key, value)
			expected[key] = value
		}
		if arena.needsCollection() {
			arena.beginCollection()
			arena.mark(root)
			for _, snapshot := range saved {
				arena.mark(snapshot.root)
			}
			arena.endCollection()
			collections++
		}
		if arena.size(root) != uint32(len(expected)) || arena.get(root, key) != expected[key] {
			t.Fatalf("wrong binding after edit %d", step)
		}
	}
	if collections == 0 {
		t.Fatal("reclamation was not exercised")
	}
	saved = append(saved, snapshot{root, expected})
	for _, snapshot := range saved {
		actual := make(map[uint32]Value)
		arena.entries(snapshot.root, 0, func(key uint32, value Value) { actual[key] = value })
		if !reflect.DeepEqual(actual, snapshot.values) {
			t.Fatal("a retained snapshot changed")
		}
	}
}

func TestNativeEnvironmentJoinsAndScopeRemoval(t *testing.T) {
	var names registry
	var pool valuePool
	global := names.key(0, names.name("value"))
	local := names.key(1, names.name("value"))
	param := names.key(parameterScope, names.name("argument"))
	arena := envArena{registry: &names}
	left := arena.set(0, global, pool.number(10))
	left = arena.set(left, local, pool.text("local"))
	right := arena.set(0, global, pool.boolean(true))
	right = arena.set(right, param, pool.number(2))
	joined := arena.join(left, right)
	if arena.get(joined, global) != NumberType|BoolType {
		t.Fatal("mixed types were not joined")
	}
	if arena.get(joined, local) != StringType|UnknownType {
		t.Fatal("a missing binding was not widened")
	}
	withoutLocals := arena.normalize(arena.dropClass(joined, 1, 0))
	if arena.get(withoutLocals, local) != 0 || arena.get(withoutLocals, global) != NumberType|BoolType {
		t.Fatal("scope removal affected globals")
	}
	withoutParams := arena.normalize(arena.dropClass(withoutLocals, 2, 0))
	if arena.get(withoutParams, param) != 0 || arena.size(withoutParams) != 1 {
		t.Fatal("parameter removal affected another scope")
	}
	forgotten := arena.forget(joined)
	if arena.size(forgotten) != arena.size(joined) || arena.get(forgotten, global) != UnknownType {
		t.Fatal("opaque effects lost binding presence")
	}
	if arena.get(left, global) != pool.number(10) {
		t.Fatal("a join mutated its input")
	}
}

func TestNativeEnvironmentCanonicalJoins(t *testing.T) {
	var names registry
	var pool valuePool
	keys := make([]uint32, 257)
	for i := range keys {
		keys[i] = names.key(uint32(i%3), names.name(primitive{Number: float64(i), Kind: uint8(NumberType)}.string()))
	}
	arena := envArena{registry: &names}
	var left, right uint32
	for i, key := range keys {
		left = arena.set(left, key, pool.number(float64(i)))
	}
	for i := len(keys) - 1; i >= 0; i-- {
		right = arena.set(right, keys[i], pool.number(float64(i)))
	}
	if arena.join(left, right) != left {
		t.Fatal("equal logical environments did not converge to their retained input")
	}
	if arena.join(right, left) != right {
		t.Fatal("memoized equal join replaced its retained input identity")
	}
	for i := range 500 {
		right = arena.set(right, keys[i%len(keys)], NumberType)
		joined := arena.join(left, right)
		if arena.join(joined, right) != joined || arena.join(joined, left) != joined {
			t.Fatal("a stable join changed identity")
		}
		left = joined
	}
}

func TestNativeEnvironmentProjectionSharesUnchangedSubtrees(t *testing.T) {
	var names registry
	var values valuePool
	arena := envArena{registry: &names}
	var root uint32
	var mask keyMask
	expected := make(map[uint32]Value)
	for i := range 5000 {
		id := names.key(uint32(i%3), names.name(primitive{Number: float64(i), Kind: uint8(NumberType)}.string()))
		v := values.number(float64(i))
		root = arena.set(root, id, v)
		if i%7 == 0 || i > 2000 && i < 3500 {
			mask.add(id)
			expected[id] = v
		}
	}
	projected := arena.normalize(arena.intersect(root, &mask, 0))
	actual := make(map[uint32]Value)
	arena.entries(projected, 0, func(id uint32, v Value) { actual[id] = v })
	if !reflect.DeepEqual(expected, actual) {
		t.Fatal("projection changed required bindings")
	}
	if arena.normalize(arena.intersect(projected, &mask, 0)) != projected {
		t.Fatal("reprojecting the same bindings allocated another environment")
	}
	newID := names.key(8, names.name("later"))
	root = arena.set(root, newID, NumberType)
	mask.add(newID)
	projected = arena.normalize(arena.intersect(root, &mask, 0))
	if arena.get(projected, newID) != NumberType {
		t.Fatal("newly registered keys were omitted")
	}
}

func TestNativeEnvironmentMaskedReturnIncludesWritesAndDeletions(t *testing.T) {
	var names registry
	var pool valuePool
	arena := envArena{registry: &names}
	var before, after uint32
	var mask keyMask
	expected := make(map[uint32]Value)
	for i := range 6000 {
		id := names.key(uint32(i%3), names.name(parameterAlias(i)))
		old := pool.number(float64(i))
		before = arena.set(before, id, old)
		expected[id] = old
		if i%3 == 0 {
			mask.add(id)
			delete(expected, id)
		} else if i%7 == 0 {
			mask.add(id)
			after = arena.set(after, id, BoolType)
			expected[id] = BoolType
		}
	}
	result := arena.replace(before, after, &mask)
	actual := make(map[uint32]Value)
	arena.entries(result, 0, func(id uint32, v Value) { actual[id] = v })
	if !reflect.DeepEqual(expected, actual) {
		t.Fatal("masked call return lost writes, deletions or caller bindings")
	}
	if arena.replace(result, after, &mask) != result {
		t.Fatal("unchanged return does not retain snapshot identity")
	}
	if arena.size(before) != 6000 {
		t.Fatal("return mutated caller snapshot")
	}
}

func TestEnvironmentOperationCacheTracksMaskChangesAndPageReuse(t *testing.T) {
	var names registry
	arena := envArena{registry: &names}
	first := names.key(0, names.name("first"))
	second := names.key(0, names.name("second"))
	var left, right uint32
	left = arena.set(left, first, NumberType)
	left = arena.set(left, second, StringType)
	right = arena.set(right, first, BoolType)
	right = arena.set(right, second, NumberType)
	var mask keyMask
	mask.add(first)
	if got := arena.replace(left, right, &mask); arena.get(got, second) != StringType {
		t.Fatal("initial return overwrote an unselected binding")
	}
	mask.add(second)
	if got := arena.replace(left, right, &mask); arena.get(got, second) != NumberType {
		t.Fatal("a mutated return mask reused its obsolete result")
	}
	selected := arena.intersect(right, &mask, 0)
	arena.beginCollection()
	arena.mark(left)
	arena.endCollection()
	replacement := arena.set(left, first, StringType)
	for range 100 {
		replacement = arena.set(replacement, second, NumberType)
	}
	projected := arena.intersect(replacement, &mask, 0)
	if arena.get(projected, first) != StringType {
		t.Fatal("a collected projection was reused after page handles changed")
	}
	_ = selected
}

// Differences are observables used to distinguish changes in presence, type and
// constant values. A flat map supplies an independent oracle for sparse roots.
func TestNativeEnvironmentDifferencesMatchSparseMapOracle(t *testing.T) {
	var names registry
	var values valuePool
	arena := envArena{registry: &names}
	var left, right uint32
	before, after := make(map[uint32]Value), make(map[uint32]Value)
	for i := range 1025 {
		id := names.key(uint32(i%3), names.name("original_"+primitive{Number: float64(i), Kind: uint8(NumberType)}.string()))
		a, b := values.number(float64(i)), values.number(float64(i))
		switch i % 4 {
		case 0:
			b = values.text("changed")
		case 1:
			b = values.number(float64(i + 1))
		case 2:
			b = 0
		case 3:
			a = 0
		}
		if a != 0 {
			before[id] = a
			left = arena.set(left, id, a)
		}
		if b != 0 {
			after[id] = b
			right = arena.set(right, id, b)
		}
	}
	var types, constants, presence uint32
	keys := make(map[uint32]bool)
	for id := range before {
		keys[id] = true
	}
	for id := range after {
		keys[id] = true
	}
	for id := range keys {
		a, b := before[id], after[id]
		if a == b {
			continue
		}
		if a == 0 || b == 0 {
			presence++
		} else if a&15 != b&15 {
			types++
		} else {
			constants++
		}
	}
	for _, pair := range [][2]uint32{{left, right}, {right, left}} {
		a, b, c := arena.differenceCounts(pair[0], pair[1])
		if a != types || b != constants || c != presence {
			t.Fatalf("difference counts = %d,%d,%d; want %d,%d,%d", a, b, c, types, constants, presence)
		}
	}
	a, b, c := arena.differenceCounts(left, left)
	if a+b+c != 0 {
		t.Fatal("identical snapshots differ")
	}
	a, b, c = arena.differenceCounts(0, left)
	if a != 0 || b != 0 || c != uint32(len(before)) {
		t.Fatal("empty snapshot difference changed")
	}
}
