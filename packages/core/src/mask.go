package core

// A bit hierarchy represents wanted environment keys without allocating another
// persistent environment. All/any summaries let projection share entire existing
// subtrees instead of copying thousands of unchanged array members per call.
type maskLevel struct{ any, all []uint16 }
type keyMask struct {
	cacheID     uint64
	version     uint32
	levels      [envDepth]maskLevel
	indexed     uint32
	arguments   int
	initialized bool
}

func growMask(values []uint16, index uint32) []uint16 {
	need := int(index) + 1
	if need <= len(values) {
		return values
	}
	if need > cap(values) {
		capacity := max(need, max(8, cap(values)*2))
		next := make([]uint16, need, capacity)
		copy(next, values)
		return next
	}
	return values[:need]
}
func (m *keyMask) add(key uint32) {
	leaf, b := key>>envShift, uint16(1)<<(key&envMask)
	if int(leaf) < len(m.levels[0].any) && m.levels[0].any[leaf]&b != 0 {
		return
	}
	m.version++
	for level := range uint32(envDepth) {
		bucket := key >> (envShift * (level + 1))
		slot := key >> (envShift * level) & envMask
		bit := uint16(1) << slot
		row := &m.levels[level]
		row.any = growMask(row.any, bucket)
		row.all = growMask(row.all, bucket)
		oldAny, oldAll := row.any[bucket], row.all[bucket]
		if level == 0 {
			row.any[bucket] |= bit
			row.all[bucket] |= bit
		} else {
			child := key >> (envShift * level)
			previous := m.levels[level-1]
			if previous.any[child] != 0 {
				row.any[bucket] |= bit
			}
			if previous.all[child] == envAllSlots {
				row.all[bucket] |= bit
			}
		}
		if row.any[bucket] == oldAny && row.all[bucket] == oldAll {
			return
		}
	}
}
func (a *envArena) intersect(root uint32, mask *keyMask, prefix uint32) uint32 {
	if root == 0 {
		return 0
	}
	if prefix != 0 {
		return a.intersectUncached(root, mask, prefix)
	}
	if result, ok := a.memoLookup(root, 0, mask, 1); ok {
		return result
	}
	return a.memoStore(root, 0, mask, 1, a.intersectUncached(root, mask, prefix))
}
func (a *envArena) intersectUncached(root uint32, mask *keyMask, prefix uint32) uint32 {
	if root == 0 {
		return 0
	}
	before := *a.page(root)
	index := prefix >> (envShift * (uint32(before.Level) + 1))
	row := mask.levels[before.Level]
	if int(index) >= len(row.any) || row.any[index] == 0 {
		return 0
	}
	if row.all[index] == envAllSlots {
		return root
	}
	slots := before.Slots
	changed := false
	var count uint32
	var classes uint8
	for i, value := range before.Slots {
		if value == 0 {
			continue
		}
		bit := uint16(1) << i
		key := prefix | uint32(i)<<(envShift*before.Level)
		if row.any[index]&bit == 0 {
			slots[i] = 0
		} else if before.Level > 0 && row.all[index]&bit == 0 {
			slots[i] = a.intersect(value, mask, key)
		}
		changed = changed || slots[i] != value
		if before.Level == 0 {
			if slots[i] != 0 {
				count++
				classes |= a.keyClass(key)
			}
		} else {
			count += a.size(slots[i])
			classes |= a.class(slots[i])
		}
	}
	if !changed {
		return root
	}
	if count == 0 {
		return 0
	}
	result := a.copy(root, before.Level)
	p := a.page(result)
	p.Slots, p.Size, p.Classes = slots, count, classes
	p.Hash = 0
	for i, value := range slots {
		p.Hash ^= environmentSlotHash(value, uint32(i))
	}
	return a.intern(result)
}
