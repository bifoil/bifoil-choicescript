package core

import (
	"context"
	"reflect"
	"testing"
)

func TestReturnProofRetainsCompleteReferenceFacts(t *testing.T) {
	examples := []string{
		"*create score 1\n*create outside 0\n*gosub update\n*set outside true\n*gosub update\n*print outside\n*print score\n*ending\n*label update\n*set score +1\n*return",
		"*create implicit_control_flow true\n*create score 1\n*gosub update 4\n*print score\n*ending\n*label update\n*params amount\n*if true\n  *set score amount + 1\n*else\n  *set score amount * 2\n*return",
		"*create implicit_control_flow true\nShe said \"Hello,\n*gosub speak\nAfter.\n*ending\n*label speak\n\n*if true\n  World.\"\n*else\n  Friend.\"\n*return",
		"*create score 1\n*gosub echo 4\n*print param_2\n*ending\n*label echo\n*params one two\n*return",
		"*create score 1\n*gosub twice 4\n*print one\n*ending\n*label twice\n*params one\n*params one\n*return",
		"*create implicit_control_flow true\n*create score 1\n*gosub update\n*print score\n*ending\n*label update\n*if true\n  *set score +1\n  *gosub update\n*return",
		"*create score 1\n*gosub change \"score\"\n*print score\n*ending\n*label change\n*params target\n*set {target} +1\n*return",
		"*create_array items 3 1\n*gosub change\n*print items[1]\n*ending\n*label change\n*temp_array items 3 true\n*set items_1 \"local\"\n*return",
	}
	for i, text := range examples {
		var expected *Project
		for _, disabled := range []bool{true, false} {
			p := NewProject()
			p.disableReturnProof = disabled
			p.AddSource(Source{URI: "file:///original/startup.txt", Text: text})
			if err := p.Analyze(context.Background()); err != nil {
				t.Fatalf("case %d: %v", i, err)
			}
			if expected == nil {
				expected = p
				continue
			}
			if !reflect.DeepEqual(expected.Tokens, p.Tokens) || !reflect.DeepEqual(expected.Documents[0].Diagnostics, p.Documents[0].Diagnostics) {
				t.Fatalf("case %d changed full classifications or diagnostics\n%v\n%v\n%v\n%v", i, expected.Tokens, p.Tokens, expected.Documents[0].Diagnostics, p.Documents[0].Diagnostics)
			}
		}
	}
}
func TestDeferredAndEagerReturnsReachSameFixedPoint(t *testing.T) {
	text := "*create implicit_control_flow true\n*create n 1\n*create flag false\n*gosub first\n*set n true\n*gosub first\n*print n\n*ending\n*label first\n*if flag\n  *gosub second\n*return\n*label second\n*set n +1\n*gosub first\n*return"
	var expected *Project
	for _, eager := range []bool{true, false} {
		p := NewProject()
		p.eagerReturns = eager
		p.disableReturnProof = true
		p.AddSource(Source{URI: "file:///original/startup.txt", Text: text})
		if err := p.Analyze(context.Background()); err != nil {
			t.Fatal(err)
		}
		if expected == nil {
			expected = p
		} else if !reflect.DeepEqual(expected.Tokens, p.Tokens) {
			t.Fatal("return worklist changed semantic classifications")
		}
	}
}
func TestArraySuffixScansMatchNestedFamilies(t *testing.T) {
	for input, want := range map[string]string{"a_1_23": "a", "a_1_": "a_1_", "a_": "a_", "a_1x": "a_1x", "a__12": "a_", "a_1_count": "a_1", "a_count_count": "a_count", "a_count": "a", "a_12_3x_4": "a_12_3x"} {
		if got := elementBase(input); got != want {
			t.Errorf("%q: %q != %q", input, got, want)
		}
	}
}
