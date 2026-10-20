package core

import (
	"context"
	"reflect"
	"testing"
)

// A separate retained-read implementation remains a differential oracle for
// compact token facts. These original scenes exercise real visible behavior.
func TestNativeCompactFactsMatchRetainedReads(t *testing.T) {
	cases := [][]string{
		{"*create_array items 2 1 2\n*temp index 1\n*temp address \"items_1\"\nValue ${items[index]}.\nCalculated ${(items[1] + index)}.\nIndirect ${{address}}.\nCall ${round(index)}.\n*set items[index] 3\n*print items[1]\n*ending"},
		{"*temp name \"guest\"\nShe said \"Hello ${name},\n\n${name} again.\"\nOutside narrative.\n*ending"},
		{"*create score 1\n*create implicit_control_flow true\n*if score > 0\n  *set score 2\n*else\n  *set score false\n*print score\n*ending"},
		{"*create output 0\n*gosub echo 1\n*print output\n*gosub echo \"next\"\n*print output & \"\"\n*ending\n*label echo\n*params incoming\n*set output incoming\n*return"},
		{"*create_array items 2 1 \"second\"\n*temp index 2\n*print items[index]\n*print items[1]\n*ending"},
		{"*temp name \"guest\"\nShe said \"Hello ${name}.\"\n*ending"},
		{"*temp ending \"\\\"\"\nShe said \"Hello ${ending}\nDone.\n*ending"},
		{"She said \"Hello,\n*gosub_scene helper speak\nDone.\n*ending", "*label speak\nWorld.\"\n*return"},
	}
	for i, sources := range cases {
		build := func(retained bool) *Project {
			p := NewProject()
			p.disableTokenFacts = retained
			p.disableReadMemo = retained
			for j, source := range sources {
				name := "startup"
				if j > 0 {
					name = "helper"
				}
				p.AddSource(Source{URI: "file:///original/" + name + ".txt", Text: source})
			}
			if err := p.Analyze(context.Background()); err != nil {
				t.Fatal(err)
			}
			return p
		}
		compact, retained := build(false), build(true)
		if !reflect.DeepEqual(compact.Tokens, retained.Tokens) {
			t.Fatalf("case %d: compact facts differ from retained reads\ncompact=%v\nretained=%v", i, compact.Tokens, retained.Tokens)
		}
		for j := range compact.Documents {
			if !reflect.DeepEqual(compact.Documents[j].Diagnostics, retained.Documents[j].Diagnostics) {
				t.Fatalf("case %d: diagnostic mismatch", i)
			}
		}
	}
}
