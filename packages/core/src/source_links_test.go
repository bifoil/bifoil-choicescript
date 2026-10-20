package core

import (
	"bytes"
	"strings"
	"testing"
)

func TestPackedTreeLinksStayExactImmutableAndSerializable(t *testing.T) {
	text := "*create score 1\n" + strings.Repeat("Original narrative.\n\n", 34000) + "*ending\n"
	source := Source{URI: "file:///original/startup.txt", Text: text}
	parsed := ParseSource(source)
	d := parsed.document
	if d.rowData.firstMetrics == nil || d.rowData.nextMetrics == nil {
		t.Fatal("paragraph tree links did not compact")
	}
	var stored bytes.Buffer
	if err := parsed.WriteParsed(&stored); err != nil {
		t.Fatal(err)
	}
	restored, err := ReadParsed(&stored, source)
	if err != nil {
		t.Fatal(err)
	}
	for i := range d.RowCount() {
		if d.rowFirstChild(uint32(i)) != restored.document.rowFirstChild(uint32(i)) || d.rowNextSibling(uint32(i)) != restored.document.rowNextSibling(uint32(i)) {
			t.Fatalf("tree link changed at %d", i)
		}
	}
	clone := parsed.CloneForTransfer()
	old := d.rowNextSibling(100)
	clone.document.setNextSibling(100, 0)
	if d.rowNextSibling(100) != old || clone.document.rowNextSibling(100) != 0 {
		t.Fatal("link mutation changed shared source")
	}
	clone.Discard()
}
