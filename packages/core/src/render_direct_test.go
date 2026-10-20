package core

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func TestDirectNarrativeRenderingPreservesAllSpansAndWarnings(t *testing.T) {
	for _, text := range []string{
		"*create gender \"male\"\n*create implicit_control_flow true\nShe said \"This is the end,\n*if gender = \"male\"\n  William.\"\n*else\n  Belle.\"\nShe walked away.\n*ending",
		"*create name \"friend\"\nShe said “Hello,\n\n“${name}.”\nOutside [b]narrative[/b].\n”An unmatched close.\n*ending",
		"*create implicit_control_flow true\n*if choice_nightmode\n  Open \"dialogue,\n*else\n  Ordinary narrative.\nUncertain continuation.\n*set broken \"unfinished\nMore continuation.\n*ending",
		"*create score 1\n" + strings.Repeat("Original narrative.\n\n", 3000) + "*ending",
	} {
		direct, reference := NewProject(), NewProject()
		reference.disableDirectRender = true
		source := Source{URI: "file:///original/startup.txt", Text: text}
		direct.AddSource(source)
		reference.AddSource(source)
		if err := direct.Analyze(context.Background()); err != nil {
			t.Fatal(err)
		}
		if err := reference.Analyze(context.Background()); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(direct.Tokens, reference.Tokens) || !reflect.DeepEqual(direct.Documents[0].Diagnostics, reference.Documents[0].Diagnostics) || !reflect.DeepEqual(direct.Symbols, reference.Symbols) || direct.WordCount(0) != reference.WordCount(0) {
			t.Fatal("direct rendering changed semantic spans or diagnostics")
		}
	}
}
