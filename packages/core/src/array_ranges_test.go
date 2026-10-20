package core

import (
	"math/rand/v2"
	"testing"
)

// A small independent element map checks prefix operations and path joins;
// billion-element cases separately require the representation to stay bounded.
func TestArrayRangesMatchElementWiseBindings(t *testing.T) {
	pool := valuePool{}
	arena := envArena{values: &pool}
	rng := rand.New(rand.NewPCG(31, 73))
	choices := []Value{0, NumberType, BoolType, StringType, bindingDeleted, NumberType | bindingMissing}
	var encoded Value
	var expected [64]Value
	for step := range 300 {
		count := rng.IntN(63) + 1
		value := choices[rng.IntN(len(choices))]
		encoded = pool.replaceArrayPrefix(encoded, []arrayRange{{uint64(count), value}}, uint64(count))
		for i := range count {
			expected[i] = value
		}
		for i, want := range expected {
			if got := pool.arrayValue(encoded, uint64(i+1)); got != want {
				t.Fatalf("step %d element %d: got %d want %d", step, i+1, got, want)
			}
		}
		otherCount := rng.IntN(63) + 1
		otherValue := choices[rng.IntN(len(choices))]
		other := pool.replaceArrayPrefix(0, []arrayRange{{uint64(otherCount), otherValue}}, uint64(otherCount))
		joined := pool.joinArrayRanges(encoded, other)
		for i, prior := range expected {
			right := Value(0)
			if i < otherCount {
				right = otherValue
			}
			want := arena.joinBinding(prior, right)
			if got := pool.arrayValue(joined, uint64(i+1)); got != want {
				t.Fatalf("join step %d element %d: got %d want %d", step, i+1, got, want)
			}
		}
	}
	huge := pool.replaceArrayPrefix(0, []arrayRange{{1000000000, NumberType}}, 1000000000)
	shortened := pool.replaceArrayPrefix(huge, []arrayRange{{2, BoolType}}, 2)
	if data, ok := pool.arrayRanges(shortened); !ok || len(data) != 2*arrayRangeWidth || pool.arrayValue(shortened, 999999999) != NumberType {
		t.Fatal("array storage depends on runtime count or loses the old tail")
	}
}
