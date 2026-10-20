package core

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

// Corrupt numeric pages must be rejected before narrowing identifiers or
// allocating arrays from lengths claimed by an interrupted cache write.
func TestSnapshotNumericFieldsRejectOverflowAndImpossibleLengths(t *testing.T) {
	encode := func(value uint64) []byte { return binary.AppendUvarint(nil, value) }
	for _, example := range []struct {
		value uint64
		bits  int
	}{{1 << 32, 32}, {1 << 40, 32}, {256, 8}, {1 << 32, 8}} {
		input := newSnapshotInput(bytes.NewReader(encode(example.value)))
		if example.bits == 32 {
			input.u32()
		} else {
			input.u8()
		}
		if input.err == nil || !strings.Contains(input.err.Error(), "overflow") {
			t.Fatal("oversized numeric field accepted", example, input.err)
		}
	}
	for _, data := range [][]byte{encode(1 << 32), encode(50), {0x80}, bytes.Repeat([]byte{0xff}, 11)} {
		input := newSnapshotInput(bytes.NewReader(data))
		if count := input.count(7); count != 0 || input.err == nil {
			t.Fatal("impossible numeric page length accepted", count, input.err)
		}
	}
	for _, value := range []uint64{0, 127, 128, 255, 256, 1<<32 - 1} {
		input := newSnapshotInput(bytes.NewReader(encode(value)))
		if got := input.u32(); uint64(got) != value || input.err != nil {
			t.Fatal("valid numeric field changed", value, got, input.err)
		}
	}
	input := newSnapshotInput(bytes.NewReader([]byte{0}))
	if input.bytes() != nil || input.err != nil {
		t.Fatal("empty byte page was rejected")
	}
}
