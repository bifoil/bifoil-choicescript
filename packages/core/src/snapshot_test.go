package core

import (
	"bytes"
	"context"
	"reflect"
	"testing"
)

func TestNativePagedSnapshotRetainsEveryLanguageFeature(t *testing.T) {
	p := analyzeExample(t, "*create_array items 2 1 true\n*temp state \"ready\"\n*if items[1] > 0\n  *print state\n*else\n  Done.\n*ending")
	position := Position{3, 10}
	hover, definition, refs := p.Hover(0, position), p.Definition(0, position), p.References(0, position, true)
	rename, err := p.Rename(0, position, "status")
	if err != nil {
		t.Fatal(err)
	}
	tokens, folds, symbols, words := p.EncodeTokens(0), p.Folding(0), p.DocumentSymbols(0), p.WordCount(0)
	p.CompactForQueries()
	var buffer bytes.Buffer
	if err := p.WriteSnapshot(&buffer); err != nil {
		t.Fatal(err)
	}
	loaded, err := ReadSnapshot(&buffer)
	if err != nil {
		t.Fatal(err)
	}
	renamed, err := loaded.Rename(0, position, "status")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(tokens, loaded.EncodeTokens(0)) || !reflect.DeepEqual(hover, loaded.Hover(0, position)) || !reflect.DeepEqual(definition, loaded.Definition(0, position)) || !reflect.DeepEqual(refs, loaded.References(0, position, true)) || !reflect.DeepEqual(rename, renamed) || !reflect.DeepEqual(folds, loaded.Folding(0)) || !reflect.DeepEqual(symbols, loaded.DocumentSymbols(0)) || words != loaded.WordCount(0) {
		t.Fatal("paging changed a language feature")
	}
}

func TestParsedCachePreservesFreshProjectSemantics(t *testing.T) {
	source := Source{URI: "file:///original/startup.txt", Version: 1, Text: "*create gender \"male\"\r\n*create implicit_control_flow true\r\nShe said \"Hello ${gender},\r\n*if gender = \"male\"\r\n    William.\"\r\n*else\r\n    Belle.\"\r\nDone Ω.\r\n*set gender \"unterminated\r\n"}
	parsed := ParseSource(source)
	var storage bytes.Buffer
	if err := parsed.WriteParsed(&storage); err != nil {
		t.Fatal(err)
	}
	restored, err := ReadParsed(&storage, source)
	if err != nil {
		t.Fatal(err)
	}
	original, cached := NewProject(), NewProject()
	original.AddSource(source)
	cached.AddParsed(restored)
	if err := original.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := cached.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(original.Tokens, cached.Tokens) || !reflect.DeepEqual(original.Documents[0].Diagnostics, cached.Documents[0].Diagnostics) || original.WordCount(0) != cached.WordCount(0) {
		t.Fatal("cached syntax changed full semantic analysis")
	}
}

func TestDetachedCacheCloneStaysImmutableDuringFullAnalysis(t *testing.T) {
	source := Source{URI: "file:///original/startup.txt", Text: "*create name \"Original\"\n*create implicit_control_flow true\nShe said \"Hello ${name},\n*if true\n  World.\"\n*else\n  Friend.\"\n*set name \"unterminated\n"}
	parsed := ParseSource(source)
	transferred := parsed.CloneForTransfer()
	var buffer bytes.Buffer
	written := make(chan error, 1)
	go func() { written <- parsed.WriteParsed(&buffer) }()
	actual := NewProject()
	actual.AddParsed(transferred)
	if err := actual.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	restored, err := ReadParsed(&buffer, source)
	if err != nil {
		t.Fatal(err)
	}
	expected := NewProject()
	expected.AddParsed(restored)
	if err := expected.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(expected.Tokens, actual.Tokens) || !reflect.DeepEqual(expected.Documents[0].Diagnostics, actual.Documents[0].Diagnostics) {
		t.Fatal("concurrent cache serialization changed complete analysis")
	}
}
