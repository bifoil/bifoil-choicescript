package core

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func TestAllocationFreeGraphAndOrdinalOrderMatchReference(t *testing.T) {
	for _, text := range []string{
		"*create implicit_control_flow true\n*create score 1\n*if score > 0\n  First.\n\n*elseif score = 0\n  Zero.\n*else\n  Other.\n*ending",
		"*fake_choice\n  #First\n    *if true\n      First.\n    *else\n      Other.\n  #Second\n    Second.\n*ending",
		"*create score 1\n" + strings.Repeat("Original narrative.\n\n", 600) + "*gosub helper\n*goto end\n*label helper\n*set score +1\n*return\n*label unreachable\nUnreachable.\n*label end\n*ending",
		"*gosub_scene helper routine\n*ending\n*label other\n*goto other",
	} {
		p := analyzeExample(t, text, "*label routine\n*return\n*label unused\nUnused.\n*ending")
		p.graphs = make([]flowGraph, len(p.Documents))
		for i, document := range p.Documents {
			dense := *document
			dense.Rows = make([]row, document.RowCount())
			for j := range dense.Rows {
				dense.Rows[j] = document.rowAt(j)
			}
			dense.rowData = nil
			original := referenceBuildGraph(&dense, &p.names)
			actual := buildGraph(document, &p.names)
			p.graphs[i] = actual
			if actual.entry != original.entry || !reflect.DeepEqual(actual.next, original.next) || !reflect.DeepEqual(actual.edges, original.edges) || !reflect.DeepEqual(actual.leaders, original.leaders) {
				t.Fatal("graph storage changed control-flow edges")
			}
		}
		p.prepareOrder()
		reference := *p
		reference.referencePrepareOrder()
		for doc, document := range p.Documents {
			for line := uint32(1); line < uint32(document.RowCount()); line++ {
				if p.rank(nodeID(uint32(doc), line)) != uint64(reference.ranks[doc][line]) {
					t.Fatalf("ordinal rank changed doc %d line %d", doc, line)
				}
			}
		}
	}
}

func TestRunOrderingRetainsCompleteAnalysis(t *testing.T) {
	for _, text := range []string{
		"*create score 1\n" + strings.Repeat("Original narrative.\n\n", 2000) + "*gosub helper\n*print score\n*ending\n*label helper\n*set score +1\n*return",
		"*create implicit_control_flow true\n*create score 0\n*label repeat\n*if score < 3\n  First \"dialogue,\n\n  \"continued.\"\n  *set score +1\n  *goto repeat\n*else\n  Final narrative.\n*ending",
		"*create name \"friend\"\n*fake_choice\n  #First\n    She said \"Hello,\n\n    ${name}.\"\n  #Second\n    Other narrative.\n*gosub helper\n*ending\n*label helper\nOriginal narrative.\n\n*return",
	} {
		actual, reference := NewProject(), NewProject()
		reference.disableRunOrder = true
		source := Source{URI: "file:///original/scenes/startup.txt", Text: text}
		actual.AddSource(source)
		reference.AddSource(source)
		if err := actual.Analyze(context.Background()); err != nil {
			t.Fatal(err)
		}
		if err := reference.Analyze(context.Background()); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(actual.Tokens, reference.Tokens) || !reflect.DeepEqual(actual.Symbols, reference.Symbols) || !reflect.DeepEqual(actual.Documents[0].Diagnostics, reference.Documents[0].Diagnostics) || actual.WordCount(0) != reference.WordCount(0) {
			t.Fatal("run ordering changed full source results")
		}
	}
}
