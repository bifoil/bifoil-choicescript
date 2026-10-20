package core

import (
	"fmt"
	"math/rand/v2"
	"reflect"
	"testing"
)

func TestClassFilteringMatchesDenseBindingsAcrossReclamation(t *testing.T) {
	var names registry
	var pool valuePool
	a := envArena{registry: &names, values: &pool}
	ids := make([]uint32, 256)
	for i := range ids {
		scope := uint32(i % 5)
		if i%7 == 0 {
			scope = parameterScope
		}
		ids[i] = names.key(scope, names.name(fmt.Sprint("value", i)))
	}
	random := rand.New(rand.NewPCG(31, 991))
	var root uint32
	dense := map[uint32]Value{}
	for step := range 500 {
		id := ids[random.IntN(len(ids))]
		value := Value(1 << random.IntN(4))
		if step%9 == 0 {
			value = 0
		}
		root = a.set(root, id, value)
		if value == 0 {
			delete(dense, id)
		} else {
			dense[id] = value
		}
		for mask := uint8(1); mask < 8; mask++ {
			want := map[uint32]Value{}
			for key, value := range dense {
				scope := names.Keys[key].Scope
				class := uint8(1)
				if scope == 0 {
					class = 4
				}
				if scope == parameterScope {
					class = 2
				}
				if class&mask == 0 {
					want[key] = value
				}
			}
			for range 2 {
				got := map[uint32]Value{}
				result := a.normalize(a.dropClass(root, mask, 0))
				a.entries(result, 0, func(k uint32, v Value) { got[k] = v })
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("step %d mask %d: lost or retained wrong scope", step, mask)
				}
			}
		}
		if step%13 == 0 {
			a.beginCollection()
			a.mark(root)
			a.endCollection()
		}
	}
}
