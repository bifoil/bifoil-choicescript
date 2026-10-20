package core

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"reflect"
	"strings"
	"testing"
)

func TestPackedSyntaxRowsRejectCorruptionAndTruncation(t *testing.T) {
	p := ParseSource(Source{URI: "file:///original/startup.txt", Text: "*create score 1\n" + strings.Repeat("Original narrative.\n\n", 700) + "*ending\n"})
	var storage bytes.Buffer
	output := newSnapshotOutput(&storage)
	output.parsedRows(p.document)
	output.flush()
	if err := output.writer.Flush(); err != nil {
		t.Fatal(err)
	}
	data := storage.Bytes()
	count, n := binary.Uvarint(data[1:])
	if n <= 0 || data[0] != 2 {
		t.Fatal("test did not create packed rows")
	}
	start := 1 + n
	if data[start] != 0 {
		t.Fatal("first block unexpectedly repeated")
	}
	start++
	badBody := append([]byte(nil), data...)
	binary.LittleEndian.PutUint32(badBody[start+24+12:], ^uint32(0))
	badFlags := append([]byte(nil), data...)
	binary.LittleEndian.PutUint32(badFlags[start+24+20:], 1<<24)
	noHeavy := append([]byte(nil), data...)
	cursor := newSnapshotInput(bytes.NewReader(data))
	cursor.u()
	cursor.u()
	for first := 0; first < int(count); first += metricBlockSize {
		size := min(metricBlockSize, int(count)-first)
		period := int(cursor.u())
		if period != 0 {
			size = period
		}
		if _, err := io.CopyN(io.Discard, cursor, int64(size*24)); err != nil {
			t.Fatal(err)
		}
	}
	cursor.metrics()
	cursor.metrics()
	noHeavy[cursor.consumed] = 0
	for _, invalid := range [][]byte{data[:1], data[:len(data)/2], badBody, badFlags, noHeavy} {
		reader := newSnapshotInput(bytes.NewReader(invalid))
		if err := reader.parsedRows(new(Document)); err == nil {
			t.Fatal("corrupt source rows accepted")
		}
	}
}

func TestRepeatedPackedSourceCacheRetainsEveryLineAndFullSemantics(t *testing.T) {
	text := "*create score 1\r\n" + strings.Repeat("Original narrative.\r\n\r\n", 40000) + "*print score\r\n*ending\r\n"
	source := Source{URI: "file:///original/startup.txt", Text: text, Version: 9}
	parsed := ParseSource(source)
	var storage bytes.Buffer
	if err := parsed.WriteParsed(&storage); err != nil {
		t.Fatal(err)
	}
	if storage.Len() > len(text)/4 {
		t.Fatalf("repeated lexical cache unnecessarily expanded: %d, period=%d, rows=%v, roots=%d syntax=%d raw=%d templates=%d text=%d", storage.Len(), sourceNodePeriod(parsed.document.rowData.nodes[256:512]), parsed.document.rowData.nodes[256:260], len(parsed.document.Roots), len(parsed.document.Syntax), len(parsed.document.RawRows), len(parsed.document.Templates), len(parsed.document.Text))
	}
	restored, err := ReadParsed(bytes.NewReader(storage.Bytes()), source)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.document.RowCount() != restored.document.RowCount() {
		t.Fatal("cache omitted physical rows")
	}
	for line := range parsed.document.RowCount() {
		if parsed.document.rowAt(line) != restored.document.rowAt(line) {
			t.Fatalf("cache changed source row %d", line)
		}
	}
	actual, expected := NewProject(), NewProject()
	actual.AddParsed(restored)
	expected.AddParsed(parsed)
	for _, p := range []*Project{actual, expected} {
		if err := p.Analyze(context.Background()); err != nil {
			t.Fatal(err)
		}
		p.CompactForQueries()
	}
	if !reflect.DeepEqual(actual.Documents, expected.Documents) || !reflect.DeepEqual(actual.Tokens, expected.Tokens) || !reflect.DeepEqual(actual.Symbols, expected.Symbols) {
		t.Fatal("lossless cache changed complete analysis")
	}
}
