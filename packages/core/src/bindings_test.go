package core

import (
	"context"
	"reflect"
	"testing"
)

func TestLocalArrayFamilyProofMatchesCompleteScopeLookups(t *testing.T) {
	fixtures := []string{
		"*create score 1\n*temp_array items 2 \"local\"\n*print score\n*print items[2]\n*print items_count",
		"*create items_1 1\n*create score true\n*temp_array items 2 \"local\"\n*temp_array items_2 3 false\n*print items[1]\n*print items_2_2\n*print score",
		"*create score 1\n*create implicit_control_flow true\n*temp_array items 3 false\n*if score > 0\n  *temp score \"local\"\n*print score\n*gosub bind \"items_2\"\n*print score\n*ending\n*label bind\n*goto arguments\n*label arguments\n*params pointer\n*set score {pointer}\n*return",
	}
	for _, text := range fixtures {
		a, b := NewProject(), NewProject()
		b.disableBindingProof = true
		b.disableReadMemo = true
		source := Source{URI: "file:///original/scenes/startup.txt", Text: text}
		a.AddSource(source)
		b.AddSource(source)
		if err := a.Analyze(context.Background()); err != nil {
			t.Fatal(err)
		}
		if err := b.Analyze(context.Background()); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(a.Tokens, b.Tokens) || !reflect.DeepEqual(a.Documents[0].Diagnostics, b.Documents[0].Diagnostics) || !reflect.DeepEqual(a.Symbols, b.Symbols) {
			t.Fatal("array-family proof changed full analysis")
		}
	}
}
func TestLocalJumpParameterProofPreservesIndirectCallPartitions(t *testing.T) {
	text := "*create source 7\n*create other true\n*create output \"\"\n*gosub via \"source\"\n*print output\n*gosub via \"other\"\n*print output & \"\"\n*ending\n*label via\n*goto bind\n*label bind\n*params pointer\n*set output {pointer}\n*return"
	p := analyzeExample(t, text)
	if nativeClassification(t, p, 0, text, "*print output") != NumberVariable || nativeClassification(t, p, 0, text, "*print output & \"\"") != BooleanVariable {
		t.Fatal("local parameter jump mixed indirect target calls")
	}
}

func TestGeneratedParametersKeepTheirLocalScope(t *testing.T) {
	text := "*create param_count \"global\"\n*create param_1 \"global\"\n*print param_count\n*gosub inspect 7 true\n*ending\n*label inspect\n*params first second\n*print param_count + 0\n*print param_1\n*print param_2\n*return"
	p := analyzeExample(t, text)
	for _, test := range []struct {
		needle string
		kind   uint8
	}{
		{"*print param_count", StringVariable},
		{"*print param_count + 0", NumberVariable},
		{"*print param_1", NumberVariable},
		{"*print param_2", BooleanVariable},
	} {
		if got := nativeClassification(t, p, 0, text, test.needle); got != test.kind {
			t.Fatalf("%s: classification %d/%d", test.needle, got, test.kind)
		}
	}
}
