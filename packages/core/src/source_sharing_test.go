package core

import (
	"bytes"
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSharedSyntaxPagesRemainImmutableDuringAnalysisAndSerialization(t *testing.T) {
	source := Source{URI: "file:///original/startup.txt", Text: "*create score 1\n*create name \"friend\"\nShe said \"Hello,\n" + strings.Repeat("${name} is here.\n", 1500) + "World.\"\n*set score 2\n*ending"}
	parsed := ParseSource(source)
	transferred := parsed.CloneForTransfer()
	actual := NewProject()
	prefix := Source{URI: "file:///original/helper.txt", Text: "*temp before true\n*return"}
	actual.AddSource(prefix)
	actual.AddParsed(transferred)
	type outcome struct {
		data []byte
		err  error
	}
	written := make(chan outcome, 1)
	go func() {
		var buffer bytes.Buffer
		err := parsed.WriteParsed(&buffer)
		written <- outcome{buffer.Bytes(), err}
	}()
	if err := actual.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	actual.CompactForQueries()
	result := <-written
	if result.err != nil {
		t.Fatal(result.err)
	}
	restored, err := ReadParsed(bytes.NewReader(result.data), source)
	if err != nil {
		t.Fatal(err)
	}
	expected := NewProject()
	expected.AddSource(prefix)
	expected.AddParsed(restored)
	if err = expected.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	expected.CompactForQueries()
	if !reflect.DeepEqual(actual.Tokens, expected.Tokens) || !reflect.DeepEqual(actual.Symbols, expected.Symbols) || !reflect.DeepEqual(actual.Documents[1].Diagnostics, expected.Documents[1].Diagnostics) {
		t.Fatal("shared cache pages were changed by canonicalization or compaction")
	}
	parsed.Discard()
}

func TestReleasedSnapshotOwnerAllowsExclusiveTableReuse(t *testing.T) {
	source := Source{URI: "file:///original/startup.txt", Text: "*create score 1\n" + strings.Repeat("Original prose.\n\n", 1000) + "*ending"}
	parsed := ParseSource(source)
	transferred := parsed.CloneForTransfer()
	project := NewProject()
	project.AddSource(Source{URI: "file:///original/helper.txt", Text: "*temp before true"})
	document := project.AddParsed(transferred)
	base := &document.rowData.nodes[0]
	parsed.Discard()
	if err := project.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	project.CompactForQueries()
	if &document.QueryRows[0] != base {
		t.Fatal("exclusive source storage was unnecessarily duplicated")
	}
	if project.WordCount(1) != 2000 {
		t.Fatal("table reuse lost source words")
	}
}

func TestLargeSourceTransferWaitIsCancellableAndReleases(t *testing.T) {
	owner := newSourceRowOwner(nil)
	second := newSourceRowOwner(owner.state.share)
	defer func() { owner.state.release(); owner.cleanup.Stop(); second.state.release(); second.cleanup.Stop() }()
	project := &Project{Documents: []*Document{{rowData: &sourceRows{nodes: make([]queryRow, 8*1024*1024/24+1), owner: owner}}}}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := project.WaitForLargeSourceTransfers(ctx); err != context.DeadlineExceeded {
		t.Fatal("source wait did not cancel", err)
	}
	second.state.release()
	second.cleanup.Stop()
	if err := project.WaitForLargeSourceTransfers(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// Tree tables must preserve every header and edge when a transferred parse is
// expanded for an edit, whether its original links were dense or compressed.
func TestTransferredRowsMaterializeWithoutChangingSiblingSnapshots(t *testing.T) {
	for _, paragraphs := range []int{1024, 34000} {
		t.Run(fmt.Sprint(paragraphs), func(t *testing.T) {
			parsed := ParseSource(Source{URI: "file:///original/startup.txt", Text: "*temp score 1\n" + strings.Repeat("Original prose.\n\n", paragraphs) + "*ending"})
			defer parsed.Discard()
			transferred := parsed.CloneForTransfer()
			defer transferred.Discard()
			original := parsed.document.rowData
			copied := transferred.document.rowData
			rows := make([]queryRow, len(original.nodes))
			first, next := make([]uint32, len(rows)-1), make([]uint32, len(rows)-1)
			for i := range rows {
				rows[i] = original.node(i)
				if i < len(first) {
					first[i], next[i] = original.firstAt(i), original.nextAt(i)
				}
			}
			changed := copied.node(10)
			changed.Indent = 42
			copied.putNode(10, changed)
			copied.materializeNodes()
			copied.mutableLinks()
			for i, expected := range rows {
				if original.node(i) != expected {
					t.Fatalf("materialization changed the original row %d", i)
				}
				if i == 10 {
					expected = changed
				}
				if copied.node(i) != expected {
					t.Fatalf("materialization lost a transferred row %d", i)
				}
			}
			if !reflect.DeepEqual(copied.first, first) || !reflect.DeepEqual(copied.next, next) {
				t.Fatal("materialization changed exact tree links")
			}
			copied.first[8], copied.next[8] = 0, 0
			for i := range first {
				if original.firstAt(i) != first[i] || original.nextAt(i) != next[i] {
					t.Fatalf("a copied link overwrote the original at %d", i)
				}
			}
			// Once a sibling is released, private modified pages can be folded
			// back into the owning table without losing that pending edit.
			sibling := transferred.CloneForTransfer()
			changed = copied.node(300)
			changed.Indent = 73
			copied.putNode(300, changed)
			sibling.Discard()
			copied.materializeNodes()
			if copied.node(300) != changed || original.node(300) != rows[300] {
				t.Fatal("exclusive page consolidation lost isolation")
			}
		})
	}
}
