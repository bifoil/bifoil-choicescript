package core

import (
	"bytes"
	"context"
	"reflect"
	"strings"
	"testing"
)

func TestNumericMetricsPreserveEveryValueAndImmutableEdits(t *testing.T) {
	values := make([]uint32, 50003)
	var total uint64
	for i := range values {
		values[i] = uint32(i%2) * 25
		if i >= 20000 && i < 25000 {
			values[i] = uint32(i) * 193
		}
		total += uint64(values[i])
	}
	metrics := packNumericMetrics(values)
	if metrics.total != total || metrics.count != len(values) {
		t.Fatal("metric count or sum changed")
	}
	for i, want := range values {
		if metrics.at(uint32(i)) != want {
			t.Fatal("metric changed", i)
		}
	}
	for _, index := range []uint32{0, 255, 256, 23001, 50002} {
		edited := metrics.updated(index, ^uint32(0))
		if edited.total != total-uint64(values[index])+uint64(^uint32(0)) {
			t.Fatal("edited total changed")
		}
		for i, want := range values {
			if metrics.at(uint32(i)) != want {
				t.Fatal("edit mutated original")
			}
			if uint32(i) == index {
				want = ^uint32(0)
			}
			if edited.at(uint32(i)) != want {
				t.Fatal("edited metric changed unrelated value", i)
			}
		}
	}
	var data bytes.Buffer
	output := newSnapshotOutput(&data)
	output.metrics(nil, metrics)
	output.flush()
	if err := output.writer.Flush(); err != nil {
		t.Fatal(err)
	}
	input := newSnapshotInput(&data)
	_, decoded := input.metrics()
	if input.err != nil {
		t.Fatal(input.err)
	}
	if decoded.total != total || decoded.count != len(values) {
		t.Fatal("metric serialization changed summary")
	}
	for i, want := range values {
		if decoded.at(uint32(i)) != want {
			t.Fatal("metric serialization changed value", i)
		}
	}
	for _, raw := range [][]byte{{2}, {1, 1, 0}, {1, 1, 1, 17, 1, 0}} {
		input := newSnapshotInput(bytes.NewReader(raw))
		input.metrics()
		if input.err == nil {
			t.Fatal("invalid metric block accepted")
		}
	}
}

func TestPackedMetricsKeepCompleteAnalysisCachesAndEdits(t *testing.T) {
	prose := "She said “Hello, Ω.”"
	text := "*create score 1\n" + strings.Repeat(prose+"\n\n", 33000) + "*ending"
	source := Source{URI: "file:///original/startup.txt", Text: text}
	packed := NewProject()
	packed.AddSource(source)
	source.denseRows = true
	dense := NewProject()
	dense.AddSource(source)
	if err := packed.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := dense.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(packed.Tokens, dense.Tokens) || !reflect.DeepEqual(packed.Symbols, dense.Symbols) || !reflect.DeepEqual(packed.Documents[0].Diagnostics, dense.Documents[0].Diagnostics) {
		t.Fatal("metric storage changed complete analysis")
	}
	if packed.Documents[0].widthMetrics == nil || packed.Documents[0].wordMetrics == nil || packed.WordCount(0) != 132000 || packed.WordCount(0) != dense.WordCount(0) {
		t.Fatal("packed metrics lost words")
	}
	for index := range dense.Documents[0].Widths {
		if packed.Documents[0].widthAt(uint32(index)) != dense.Documents[0].Widths[index] {
			t.Fatal("packed width changed", index)
		}
	}
	source.denseRows = false
	parsed := ParseSource(source)
	var syntax bytes.Buffer
	if err := parsed.WriteParsed(&syntax); err != nil {
		t.Fatal(err)
	}
	restored, err := ReadParsed(&syntax, source)
	if err != nil {
		t.Fatal(err)
	}
	cached := NewProject()
	cached.AddParsed(restored)
	if err = cached.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(packed.Tokens, cached.Tokens) || packed.WordCount(0) != cached.WordCount(0) {
		t.Fatal("syntax cache lost packed metrics")
	}
	packed.CompactForQueries()
	var query bytes.Buffer
	if err = packed.WriteSnapshot(&query); err != nil {
		t.Fatal(err)
	}
	reloaded, err := ReadSnapshot(&query)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(packed.Tokens, reloaded.Tokens) || packed.WordCount(0) != reloaded.WordCount(0) {
		t.Fatal("query cache lost packed metrics")
	}
	const line = 33001
	changed := prose + " Original extra."
	edited, ok := reloaded.PatchPureProse(0, line, changed, 2)
	if !ok || edited.WordCount(0) != 132002 || reloaded.WordCount(0) != 132000 || edited.Documents[0].LineWidth(line) != units(changed) || reloaded.Documents[0].LineWidth(line) != units(prose) {
		t.Fatal("packed immutable edit lost widths or word counts")
	}
}
