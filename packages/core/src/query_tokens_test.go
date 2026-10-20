package core

import (
	"bytes"
	"context"
	"math/rand/v2"
	"reflect"
	"strings"
	"testing"
)

func TestQueryTokenBlocksPreserveEveryFieldAndRandomAccess(t *testing.T) {
	tokens := make([]Token, 180003)
	random := rand.New(rand.NewPCG(773, 19))
	for i := range tokens {
		block, offset := i/queryTokenBlockSize, i%queryTokenBlockSize
		tokens[i] = Token{Line: uint32(i * 3), Start: uint32(offset % 3), Length: 17, Type: Narrative}
		if block%7 == 0 {
			tokens[i].Length = uint32(random.IntN(1000) + 1)
			tokens[i].Symbol = uint32(offset)
			tokens[i].ReferenceLength = uint32(offset % 11)
			tokens[i].Modifiers = uint8(offset % 4)
		}
	}
	p := &Project{Tokens: [][]Token{tokens}}
	p.compactQueryTokens()
	if p.queryTokens[0] == nil {
		t.Fatal("repeated spans did not compact")
	}
	sequence := p.TokenSequence(0)
	if sequence.Len() != len(tokens) {
		t.Fatal("token count changed")
	}
	for index, actual := range sequence.All() {
		if actual != tokens[index] {
			t.Fatalf("token %d changed", index)
		}
	}
	for range 10000 {
		index := random.IntN(len(tokens))
		if sequence.At(index) != tokens[index] {
			t.Fatalf("random access %d changed", index)
		}
	}
	for _, index := range []int{0, 255, 256, 65536, len(tokens) - 1} {
		position := Position{Line: tokens[index].Line, Character: tokens[index].Start}
		actual := p.TokenAt(0, position)
		if actual == nil || *actual != tokens[index] {
			t.Fatalf("lookup %d lost span", index)
		}
	}
}

func TestPackedQueryTokensPreserveSnapshotsAndImmutableProseEdits(t *testing.T) {
	source := "*create score 1\n" + strings.Repeat("Original prose.\n", 70001) + "*print score\n*ending"
	build := func(text string) *Project {
		p := NewProject()
		p.AddSource(Source{URI: "file:///original/startup.txt", Text: text, Version: 1})
		if err := p.Analyze(context.Background()); err != nil {
			t.Fatal(err)
		}
		return p
	}
	p := build(source)
	before := p.EncodeTokens(0)
	p.CompactForQueries()
	if p.queryTokens[0] == nil || !reflect.DeepEqual(before, p.EncodeTokens(0)) {
		t.Fatal("compaction changed classifications")
	}
	position := Position{Line: 70002, Character: 8}
	references := p.References(0, position, true)
	if len(references) != 2 {
		t.Fatal("packed references lost a symbol")
	}
	q, ok := p.PatchPureProse(0, 33333, "Changed original prose.", 2)
	if !ok {
		t.Fatal("same-span immutable edit declined")
	}
	expected := build(strings.Replace(source, strings.Repeat("Original prose.\n", 33333), strings.Repeat("Original prose.\n", 33332)+"Changed original prose.\n", 1))
	expected.CompactForQueries()
	if !reflect.DeepEqual(q.EncodeTokens(0), expected.EncodeTokens(0)) || !reflect.DeepEqual(before, p.EncodeTokens(0)) {
		t.Fatal("edit changed original or differs from full analysis")
	}
	var saved bytes.Buffer
	if err := q.WriteSnapshot(&saved); err != nil {
		t.Fatal(err)
	}
	restored, err := ReadSnapshot(&saved)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(restored.EncodeTokens(0), q.EncodeTokens(0)) || !reflect.DeepEqual(restored.References(0, position, true), references) {
		t.Fatal("paging lost tokens or navigation")
	}
}

func TestPackedTokenInsertionsAndDeletionsAcrossBlockBoundaries(t *testing.T) {
	want := make([]Token, 70003)
	for index := range want {
		want[index] = Token{Line: uint32(index * 2), Length: 17, Type: Narrative}
	}
	p := &Project{Tokens: [][]Token{want}}
	p.compactQueryTokens()
	random := rand.New(rand.NewPCG(37, 991))
	for step := range 30 {
		first := random.IntN(len(want) + 1)
		last := min(len(want), first+random.IntN(520))
		if step == 0 {
			first = 255
			last = 257
		}
		if step == 1 {
			first = len(want)
			last = first
		}
		if step == 2 {
			first = 0
			last = 0
		}
		replacement := make([]Token, random.IntN(6))
		for i := range replacement {
			replacement[i] = Token{Line: uint32(step), Start: uint32(i), Length: 3, Type: Dialogue, Symbol: uint32(i + 1)}
		}
		oldSequence := p.TokenSequence(0)
		saved := oldSequence.At(1000)
		q := *p
		if !p.replaceQueryTokens(&q, 0, first, last, replacement) {
			t.Fatal("packed replacement failed")
		}
		updated := make([]Token, 0, len(want)-(last-first)+len(replacement))
		updated = append(updated, want[:first]...)
		updated = append(updated, replacement...)
		updated = append(updated, want[last:]...)
		want = updated
		if q.TokenSequence(0).Len() != len(want) || oldSequence.At(1000) != saved {
			t.Fatal("count or original snapshot changed")
		}
		for i, actual := range q.TokenSequence(0).All() {
			if actual != want[i] || q.TokenSequence(0).At(i) != actual {
				t.Fatalf("edit %d token %d differs from dense edit", step, i)
			}
		}
		p = &q
	}
}
