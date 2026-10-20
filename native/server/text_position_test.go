package main

import (
	"runtime"
	"strings"
	"testing"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

func TestStoredPositionsMatchExactUTF16AndPhysicalLineRules(t *testing.T) {
	for _, text := range []string{"", "Ω😀 text\r\nlast\rrow\n", "\ufeff😀\n\n", "\xc3(\r\noriginal"} {
		stored := captureTestBuffer(t, text)
		for line := range uint32(8) {
			for column := range uint32(20) {
				position := core.Position{Line: line, Character: column}
				expected, oldErr := textOffset(text, position)
				actual, newErr := stored.Store.position(position)
				if (oldErr == nil) != (newErr == nil) || oldErr == nil && int64(expected) != actual {
					t.Fatalf("UTF-16 position mismatch at %+v", position)
				}
			}
		}
	}
}
func TestStoredPositionInHugeParagraphDoesNotAllocateTheParagraph(t *testing.T) {
	const ascii = 8 * 1024 * 1024
	text := strings.Repeat("a", ascii) + "😀Ωz\r\nLast."
	stored := captureTestBuffer(t, text)
	position := core.Position{Character: ascii + 3}
	expected, err := textOffset(text, position)
	if err != nil {
		t.Fatal(err)
	}
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	actual, err := stored.Store.position(position)
	runtime.ReadMemStats(&after)
	if err != nil || actual != int64(expected) {
		t.Fatal("huge-line position changed", err)
	}
	if after.TotalAlloc-before.TotalAlloc > 1024*1024 {
		t.Fatalf("position allocated paragraph storage: %d", after.TotalAlloc-before.TotalAlloc)
	}
	if _, err = stored.Store.position(core.Position{Character: ascii + 1}); err == nil {
		t.Fatal("accepted a split surrogate pair")
	}
}
