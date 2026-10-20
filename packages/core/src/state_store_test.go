package core

import "testing"

func TestNativeNumericStatesMatchSparseContextsAndQueueFlags(t *testing.T) {
	var store stateStore
	expected := make(map[stateKey]flowState)
	pending := make(map[stateKey]bool)
	for step := range uint32(40000) {
		key := stateKey{nodeID(step%23, (step*3571)%4096+1), step % 7}
		if step%5 == 0 {
			store.remove(key)
			delete(expected, key)
		} else {
			value := flowState{step + 1, uint8(step%7 + 1), step%2 == 0}
			store.set(key, value)
			expected[key] = value
		}
		flag := step%3 == 0
		store.setPending(key, flag)
		pending[key] = flag
		if store.get(key) != expected[key] || store.isPending(key) != pending[key] || store.count != len(expected) {
			t.Fatal("numeric state storage changed flow or queue membership", step)
		}
	}
	actual := make(map[flowState]int)
	store.each(func(s flowState) { actual[s]++ })
	for key, value := range expected {
		if store.get(key) != value || actual[value] != 1 {
			t.Fatal("a scene/context state was lost")
		}
	}
	store.reset()
	if store.count != 0 || len(store.documents) != 0 {
		t.Fatal("retired project roots retained state pages")
	}
}
