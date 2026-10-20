package core

import "sync/atomic"

var maskSerial atomic.Uint64

// Numeric direct-mapped entries reuse exact immutable environment operations.
// Both operands, mask identity and mask version are checked; hash collisions are
// misses. Collection clears entries before any page handle can be reused.
type environmentMemo struct {
	operands, mask uint64
	version, root  uint32
}

func (a *envArena) memoLookup(left, right uint32, mask *keyMask, operation uint64) (uint32, bool) {
	if mask.cacheID == 0 {
		mask.cacheID = maskSerial.Add(1)
	}
	if a.operations == nil {
		a.operations = make([]environmentMemo, 65536)
	}
	operands := uint64(left)<<24 | uint64(right) | operation<<56
	index := environmentOperationHash(operands, mask.cacheID, mask.version) & uint32(len(a.operations)-1)
	memo := a.operations[index]
	if memo.operands == operands && memo.mask == mask.cacheID && memo.version == mask.version {
		return memo.root, true
	}
	return 0, false
}
func (a *envArena) memoStore(left, right uint32, mask *keyMask, operation uint64, root uint32) uint32 {
	operands := uint64(left)<<24 | uint64(right) | operation<<56
	index := environmentOperationHash(operands, mask.cacheID, mask.version) & uint32(len(a.operations)-1)
	a.operations[index] = environmentMemo{operands, mask.cacheID, mask.version, root}
	return root
}

func environmentOperationHash(operands, mask uint64, version uint32) uint32 {
	hash := operands ^ mask*0x9e3779b97f4a7c15 ^ uint64(version)*0x85ebca6b
	hash = (hash ^ (hash >> 30)) * 0xbf58476d1ce4e5b9
	hash = (hash ^ (hash >> 27)) * 0x94d049bb133111eb
	return uint32(hash ^ (hash >> 31))
}
