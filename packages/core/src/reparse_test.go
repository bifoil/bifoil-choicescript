package core

import (
	"bytes"
	"context"
	"reflect"
	"strings"
	"testing"
)

func TestSyntaxReplayRunsFullFlowAndMatchesFreshParsing(t *testing.T) {
	for _, text := range []string{
		"*create score 1\n*create implicit_control_flow true\n*if choice_nightmode\n  *print score\n*else\n  *gosub change\n*print score\nMore narrative.\n*ending\n*label change\n*set score false\n*return",
		"*create score 1\r\n*temp_array items 3 score\r\n*print items[1]\r\nMore narrative.\r\n*ending\r\n",
		"*create score 1\n" + strings.Repeat("Original narrative.\n\n", 34000) + "*print score\n*ending",
	} {
		source := Source{URI: "file:///original/startup.txt", Text: text, Version: 1}
		original := ParseSource(source)
		var storage bytes.Buffer
		if err := original.WriteParsed(&storage); err != nil {
			t.Fatal(err)
		}
		for _, after := range []string{"*create score true", `*create score "She said \"Hello"`, "*create score 7"} {
			baseline, err := ReadParsed(bytes.NewReader(storage.Bytes()), source)
			if err != nil {
				t.Fatal(err)
			}
			accepted, err := baseline.ApplySourceLineEdit(context.Background(), 0, SourceLineEdit{Before: "*create score 1", After: after}, 2)
			if err != nil || !accepted {
				t.Fatal("supported literal edit rejected", after, err)
			}
			actual, expected := NewProject(), NewProject()
			actual.AddParsed(baseline)
			source.Version = 2
			source.Text = strings.Replace(text, "*create score 1", after, 1)
			expected.AddSource(source)
			for _, p := range []*Project{actual, expected} {
				if err := p.Analyze(context.Background()); err != nil {
					t.Fatal(err)
				}
				p.CompactForQueries()
			}
			if !reflect.DeepEqual(actual.Tokens, expected.Tokens) || !reflect.DeepEqual(actual.Documents, expected.Documents) || !reflect.DeepEqual(actual.Symbols, expected.Symbols) {
				t.Fatal("cached lexical replacement changed full flow, dialogue, or ranges", after)
			}
		}
	}
}
func TestPlainSourceReplayKeepsPhysicalRangesAndExactWordCounts(t *testing.T) {
	source := Source{URI: "file:///original/startup.txt", Text: "*create score 1\r\nOriginal narrative.\r\n*print score\r\n*ending\r\n"}
	parsed := ParseSource(source)
	ok, err := parsed.ApplySourceLineEdit(context.Background(), 1, SourceLineEdit{Before: "Original narrative.", After: "Original Ω😀 expanded narrative."}, 2)
	if err != nil || !ok {
		t.Fatal(err)
	}
	fresh := ParseSource(Source{URI: source.URI, Version: 2, Text: strings.Replace(source.Text, "Original narrative.", "Original Ω😀 expanded narrative.", 1)})
	for i := range fresh.document.RowCount() {
		if parsed.document.rowAt(i) != fresh.document.rowAt(i) {
			t.Fatalf("physical source row changed at %d", i)
		}
	}
	a, b := NewProject(), NewProject()
	a.AddParsed(parsed)
	b.AddParsed(fresh)
	for _, p := range []*Project{a, b} {
		if err = p.Analyze(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(a.Tokens, b.Tokens) || a.WordCount(0) != b.WordCount(0) {
		t.Fatal("plain replay omitted facts")
	}
}
func TestSourceReplayRejectsStructuralChangesAndCancellation(t *testing.T) {
	for _, after := range []string{"*create other 1", " *create score 1", "*create score (1+2)", "*create score \"broken", "*create score 1\nMore"} {
		parsed := ParseSource(Source{Text: "*create score 1\n*print score\n*ending"})
		ok, err := parsed.ApplySourceLineEdit(context.Background(), 0, SourceLineEdit{Before: "*create score 1", After: after}, 2)
		if err != nil || ok {
			t.Fatal("structural edit reused old syntax", after, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	parsed := ParseSource(Source{Text: "*create score 1\n*print score\n*ending"})
	if ok, err := parsed.ApplySourceLineEdit(ctx, 0, SourceLineEdit{Before: "*create score 1", After: "*create score 2"}, 2); ok || err != context.Canceled {
		t.Fatal("cancelled replay succeeded", err)
	}
}
