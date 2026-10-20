package core

import (
	"math/rand/v2"
	"strings"
	"testing"
)

func TestASCIIWordRunPreservesBoundariesAcrossLongInput(t *testing.T) {
	samples := []string{"", strings.Repeat("one two THREE 123 four ", 100), strings.Repeat("a", 4097), strings.Repeat(" ", 4097)}
	for value := range 256 {
		for column := range 65 {
			samples = append(samples, strings.Repeat("a ", 33)[:column]+string(byte(value))+strings.Repeat("b0 c_", 14))
		}
	}
	random := rand.New(rand.NewPCG(51, 19))
	for range 1000 {
		data := make([]byte, random.IntN(4096))
		for i := range data {
			data[i] = byte(random.IntN(256))
		}
		samples = append(samples, string(data))
	}
	for _, sample := range samples {
		for _, inside := range []bool{false, true} {
			n, starts, last := asciiWordRun(sample, inside)
			expected, carry := uint32(0), inside
			for i := range n {
				b := sample[i]
				word := b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9'
				if word && !carry {
					expected++
				}
				carry = word
			}
			if expected != starts || last != carry {
				t.Fatal("combined word scan changed boundaries")
			}
		}
	}
}
