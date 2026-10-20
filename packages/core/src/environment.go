package core

import "errors"

// Environment pages contain numeric values/handles only. The Go collector does
// not scan a graph of per-binding objects; flow owns reclamation at safe points.
type envPage struct {
	Slots   [envFanout]uint32
	Size    uint32
	Next    uint32
	Hash    uint32
	Level   uint8
	Mark    uint8
	Classes uint8
}

type joinMemo struct {
	key  uint64
	root uint32
}
type pageIntern struct {
	hash uint32
	root uint32
}
type classMemo struct {
	root, result uint32
	classes      uint8
}

type bindingRead struct {
	root, scope, name uint32
	value             Value
	bindingScope      uint32
}

type envArena struct {
	reads                            []bindingRead
	classFilters                     []classMemo
	operations                       []environmentMemo
	interned                         []pageIntern
	values                           *valuePool
	memo                             []joinMemo
	chunks                           []*[1024]envPage
	used, free, freeCount, allocated uint32
	epoch                            uint8
	registry                         *registry
}

var ErrAnalysisMemory = errors.New("the complete analysis exceeded its environment storage budget")

const envShift = 4
const envFanout = 1 << envShift
const envMask = envFanout - 1
const envDepth = (32 + envShift - 1) / envShift
const envAllSlots = (1 << envFanout) - 1
const maxEnvPages = 64 * 1024 * 1024 / (envFanout*4 + 16)
const parameterScope = ^uint32(0)

func (a *envArena) page(id uint32) *envPage { return &a.chunks[id>>10][id&1023] }
func (a *envArena) size(id uint32) uint32 {
	if id == 0 {
		return 0
	}
	return a.page(id).Size
}
func (a *envArena) class(id uint32) uint8 {
	if id == 0 {
		return 0
	}
	return a.page(id).Classes
}
func (a *envArena) keyClass(id uint32) uint8 {
	scope := a.registry.Keys[id].Scope
	if scope == 0 {
		return 4
	}
	if scope == parameterScope {
		return 2
	}
	return 1
}
func (a *envArena) allocate(level uint8) uint32 {
	var id uint32
	if a.free != 0 {
		id = a.free
		a.free = a.page(id).Next
		a.freeCount--
	} else {
		if a.used >= maxEnvPages {
			panic(ErrAnalysisMemory)
		}
		a.used++
		id = a.used
		for int(id>>10) >= len(a.chunks) {
			a.chunks = append(a.chunks, new([1024]envPage))
		}
	}
	*a.page(id) = envPage{Level: level}
	a.allocated++
	return id
}
func (a *envArena) copy(root uint32, level uint8) uint32 {
	id := a.allocate(level)
	if root != 0 {
		*a.page(id) = *a.page(root)
		a.page(id).Mark = 0
		a.page(id).Next = 0
	}
	return id
}
func (a *envArena) get(root, key uint32) Value {
	if root == 0 {
		return 0
	}
	level := a.page(root).Level
	if level < envDepth-1 && key>>(envShift*(level+1)) != 0 {
		return 0
	}
	for level > 0 {
		root = a.page(root).Slots[(key>>(envShift*level))&envMask]
		if root == 0 {
			return 0
		}
		level--
	}
	return Value(a.page(root).Slots[key&envMask])
}
func (a *envArena) normalize(root uint32) uint32 {
	for root != 0 && a.page(root).Level > 0 {
		p := a.page(root)
		if p.Slots[0] == 0 {
			break
		}
		only := true
		for i := 1; i < envFanout; i++ {
			if p.Slots[i] != 0 {
				only = false
				break
			}
		}
		if !only {
			break
		}
		root = p.Slots[0]
	}
	return root
}
func (a *envArena) set(root, key uint32, value Value) uint32 {
	if value == 0 && a.get(root, key) == 0 {
		return root
	}
	var level uint8
	if root != 0 {
		level = a.page(root).Level
	}
	var required uint8
	for rest := key >> envShift; rest != 0; rest >>= envShift {
		required++
	}
	for root != 0 && level < required {
		level++
		next := a.allocate(level)
		a.page(next).Slots[0] = root
		a.page(next).Hash = environmentSlotHash(root, 0)
		a.page(next).Size = a.size(root)
		a.page(next).Classes = a.class(root)
		root = next
	}
	if level < required {
		level = required
	}
	return a.normalize(a.setAt(root, key, uint32(value), level))
}
func (a *envArena) setAt(root, key, value uint32, level uint8) uint32 {
	slot := (key >> (envShift * level)) & envMask
	var before uint32
	if root != 0 {
		before = a.page(root).Slots[slot]
	}
	after := value
	if level > 0 {
		after = a.setAt(before, key, value, level-1)
	}
	if before == after {
		return root
	}
	oldCount, newCount := uint32(0), uint32(0)
	if level > 0 {
		oldCount, newCount = a.size(before), a.size(after)
	} else {
		if before != 0 {
			oldCount = 1
		}
		if after != 0 {
			newCount = 1
		}
	}
	count := a.size(root) - oldCount + newCount
	if count == 0 {
		return 0
	}
	result := a.copy(root, level)
	p := a.page(result)
	p.Slots[slot] = after
	p.Hash ^= environmentSlotHash(before, slot) ^ environmentSlotHash(after, slot)
	p.Size = count
	if level > 0 {
		if root == 0 || a.class(before) != a.class(after) {
			p.Classes = 0
			for _, child := range p.Slots {
				p.Classes |= a.class(child)
			}
		}
	} else if before == 0 || after == 0 {
		p.Classes = 0
		prefix := key &^ envMask
		for i, v := range p.Slots {
			if v != 0 {
				p.Classes |= a.keyClass(prefix | uint32(i))
			}
		}
	}
	return a.intern(result)
}
func (a *envArena) child(root uint32, slot int, level uint8) uint32 {
	if root == 0 {
		return 0
	}
	if a.page(root).Level < level {
		if slot == 0 {
			return root
		}
		return 0
	}
	return a.page(root).Slots[slot]
}
func (a *envArena) join(left, right uint32) uint32 {
	var level uint8
	if left != 0 {
		level = a.page(left).Level
	}
	if right != 0 && a.page(right).Level > level {
		level = a.page(right).Level
	}
	return a.normalize(a.joinAt(left, right, level))
}
func (a *envArena) joinAt(left, right uint32, level uint8) (result uint32) {
	if left == right {
		return left
	}
	if a.memo == nil {
		a.memo = make([]joinMemo, 262144)
	}
	// Joins are commutative in value, but unchanged joins must retain the left
	// snapshot identity. Sorting cache operands can cause endless identity churn.
	code := uint64(left)<<24 | uint64(right) | uint64(level)<<48
	hash := (code ^ (code >> 23)) * 0x9e3779b97f4a7c15
	slot := uint32(hash^(hash>>32)) & 262143
	if cached := a.memo[slot]; cached.key == code {
		return cached.root
	}
	defer func() { a.memo[slot] = joinMemo{code, result} }()
	var slots [envFanout]uint32
	var count uint32
	var classes uint8
	sameLeft := left != 0 && a.page(left).Level == level
	sameRight := right != 0 && a.page(right).Level == level
	for i := range envFanout {
		x, y := a.child(left, i, level), a.child(right, i, level)
		if level > 0 {
			slots[i] = a.joinAt(x, y, level-1)
			count += a.size(slots[i])
			classes |= a.class(slots[i])
		} else if x != 0 || y != 0 {
			if a.values != nil {
				slots[i] = uint32(a.joinBinding(Value(x), Value(y)))
			} else {
				slots[i] = uint32(joinValue(Value(x), Value(y)))
			}
			count++
		}
		if slots[i] != x {
			sameLeft = false
		}
		if slots[i] != y {
			sameRight = false
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
	result = a.allocate(level)
	p := a.page(result)
	p.Slots, p.Size, p.Classes = slots, count, classes
	for i, value := range slots {
		p.Hash ^= environmentSlotHash(value, uint32(i))
	}
	if level == 0 {
		p.Classes = a.class(left) | a.class(right)
	}
	return a.intern(result)
}
func (a *envArena) forget(root uint32) uint32 { return a.forgetValues(root, false) }
func (a *envArena) forgetValues(root uint32, dynamic bool) uint32 {
	if root == 0 {
		return 0
	}
	before := *a.page(root)
	slots := before.Slots
	changed := false
	for i, value := range slots {
		if before.Level > 0 {
			slots[i] = a.forgetValues(value, dynamic)
		} else if value != 0 {
			flags := Value(value) & bindingPresence
			if dynamic {
				flags |= bindingPresence
			}
			present := Value(value) &^ bindingPresence
			if present != 0 {
				present = UnknownType
			}
			slots[i] = uint32(present | flags)
		}
		changed = changed || slots[i] != value
	}
	if !changed {
		return root
	}
	result := a.copy(root, before.Level)
	a.page(result).Slots = slots
	a.page(result).Hash = 0
	for i, value := range slots {
		a.page(result).Hash ^= environmentSlotHash(value, uint32(i))
	}
	return a.intern(result)
}
func (a *envArena) dropClass(root uint32, classes uint8, prefix uint32) uint32 {
	if root == 0 || a.class(root)&classes == 0 {
		return root
	}
	if a.class(root)&^classes == 0 {
		return 0
	}
	// Class filtering is pure for a complete environment. Cache only prefix-zero
	// roots: identical interned subpages can live under different key prefixes.
	var memo *classMemo
	if prefix == 0 {
		if a.classFilters == nil {
			a.classFilters = make([]classMemo, 16384)
		}
		index := (root*2654435761 ^ uint32(classes)*2246822519) & uint32(len(a.classFilters)-1)
		memo = &a.classFilters[index]
		if memo.root == root && memo.classes == classes {
			return memo.result
		}
	}
	result := a.dropClassUncached(root, classes, prefix)
	if memo != nil {
		*memo = classMemo{root, result, classes}
	}
	return result
}
func (a *envArena) dropClassUncached(root uint32, classes uint8, prefix uint32) uint32 {
	before := *a.page(root)
	slots := before.Slots
	var count uint32
	var remaining uint8
	for i, value := range slots {
		if value == 0 {
			continue
		}
		key := prefix | uint32(i)<<(envShift*before.Level)
		if before.Level > 0 {
			slots[i] = a.dropClass(value, classes, key)
			count += a.size(slots[i])
			remaining |= a.class(slots[i])
		} else {
			class := a.keyClass(key)
			if class&classes != 0 {
				slots[i] = 0
			} else {
				count++
				remaining |= class
			}
		}
	}
	if count == 0 {
		return 0
	}
	result := a.copy(root, before.Level)
	a.page(result).Slots, a.page(result).Size, a.page(result).Classes = slots, count, remaining
	a.page(result).Hash = 0
	for i, value := range slots {
		a.page(result).Hash ^= environmentSlotHash(value, uint32(i))
	}
	return a.intern(result)
}
func (a *envArena) entries(root, prefix uint32, visit func(uint32, Value)) {
	if root == 0 {
		return
	}
	p := *a.page(root)
	for i, value := range p.Slots {
		if value == 0 {
			continue
		}
		key := prefix | uint32(i)<<(envShift*p.Level)
		if p.Level > 0 {
			a.entries(value, key, visit)
		} else {
			visit(key, Value(value))
		}
	}
}
func (a *envArena) needsCollection() bool {
	return a.allocated*(envFanout*4+16) >= 20*1024*1024 || a.allocated >= 4096 && a.used+4096 >= maxEnvPages && a.freeCount < 4096
}
func (a *envArena) beginCollection() {
	clear(a.reads)
	clear(a.classFilters)
	clear(a.operations)
	clear(a.memo)
	clear(a.interned)
	a.epoch++
	if a.epoch == 0 {
		for i := uint32(1); i <= a.used; i++ {
			a.page(i).Mark = 0
		}
		a.epoch = 1
	}
}
func (a *envArena) mark(root uint32) {
	if root == 0 || a.page(root).Mark == a.epoch {
		return
	}
	a.page(root).Mark = a.epoch
	if a.page(root).Level > 0 {
		for _, child := range a.page(root).Slots {
			a.mark(child)
		}
	}
}
func (a *envArena) endCollection() {
	a.free, a.freeCount = 0, 0
	for i := uint32(1); i <= a.used; i++ {
		p := a.page(i)
		if p.Mark != a.epoch {
			p.Next = a.free
			a.free = i
			a.freeCount++
		}
	}
	a.allocated = 0
}

func (a *envArena) differenceCounts(left, right uint32) (types, constants, presence uint32) {
	var level uint8
	if left != 0 {
		level = a.page(left).Level
	}
	if right != 0 && a.page(right).Level > level {
		level = a.page(right).Level
	}
	var visit func(uint32, uint32, uint8)
	visit = func(left, right uint32, level uint8) {
		if left == right {
			return
		}
		for i := range envFanout {
			x, y := a.child(left, i, level), a.child(right, i, level)
			if level > 0 {
				visit(x, y, level-1)
			} else if x != y {
				if x == 0 || y == 0 {
					presence++
				} else if x&15 != y&15 {
					types++
				} else {
					constants++
				}
			}
		}
	}
	visit(left, right, level)
	return
}

func environmentSlotHash(value, slot uint32) uint32 {
	if value == 0 {
		return 0
	}
	x := value + (slot+1)*0x9e3779b9
	x ^= x >> 16
	x *= 0x85ebca6b
	x ^= x >> 13
	return x
}

// Weak bounded interning shares equal immutable pages without retaining them as
// collection roots. Exact slot/metadata comparison resolves every hash collision;
// clearing the table precedes reclamation and numeric-handle reuse.
func (a *envArena) intern(id uint32) uint32 {
	if a.interned == nil {
		a.interned = make([]pageIntern, 262144)
	}
	p := a.page(id)
	hash := p.Hash ^ uint32(p.Level)*0x27d4eb2d ^ uint32(p.Classes)*0x165667b1
	slot := (hash ^ (hash >> 16)) & 262143
	previous := a.interned[slot]
	if previous.root != 0 && previous.hash == hash {
		q := a.page(previous.root)
		if q.Level == p.Level && q.Classes == p.Classes && q.Size == p.Size && q.Slots == p.Slots {
			p.Next = a.free
			a.free = id
			a.freeCount++
			a.allocated--
			return previous.root
		}
	}
	a.interned[slot] = pageIntern{hash, id}
	return id
}
