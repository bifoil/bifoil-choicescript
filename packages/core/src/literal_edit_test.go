package core

import (
	"bytes"
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func literalEditProject(t *testing.T, text, helper string, version int32) *Project {
	t.Helper()
	p := NewProject()
	p.AddSource(Source{URI: "file:///original/startup.txt", Text: text, Version: version})
	if helper != "" {
		p.AddSource(Source{URI: "file:///original/helper.txt", Text: helper, Version: 1})
	}
	if err := p.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	p.CompactForQueries()
	return p
}
func TestUnusedLiteralEditsMatchFreshCompleteAnalysisAndCachedProofs(t *testing.T) {
	helper := "*label speak\nWorld.\"\n*return"
	for _, ending := range []string{"\n", "\r\n"} {
		for _, replacement := range []string{"true", "22", `"Original Ω😀"`, `"A \"quote\""`} {
			before := "*create spare 1"
			after := "*create spare " + replacement
			text := strings.Join([]string{"She said \"Hello,", before, "*gosub_scene helper speak", "Finished.", "*ending"}, ending)
			old := literalEditProject(t, text, helper, 1)
			var stored bytes.Buffer
			if err := old.WriteSnapshot(&stored); err != nil {
				t.Fatal(err)
			}
			cached, err := ReadSnapshot(&stored)
			if err != nil {
				t.Fatal(err)
			}
			for _, original := range []*Project{old, cached} {
				patched, accepted := original.PatchUnusedLiteral(0, 1, before, after, 2)
				if !accepted {
					t.Fatalf("safe edit rejected: %s", after)
				}
				expected := literalEditProject(t, strings.Replace(text, before, after, 1), helper, 2)
				if !reflect.DeepEqual(patched.Tokens, expected.Tokens) || !reflect.DeepEqual(patched.Documents, expected.Documents) || !reflect.DeepEqual(patched.Symbols, expected.Symbols) {
					t.Fatalf("exact edit differs from full analysis: %s", after)
				}
				for i, value := range patched.SymbolValues {
					if value&15 != expected.SymbolValues[i]&15 {
						t.Fatal("symbol type differs from full analysis")
					}
				}
				position := Position{Line: 1, Character: 9}
				if !reflect.DeepEqual(patched.Hover(0, position), expected.Hover(0, position)) || !reflect.DeepEqual(patched.Definition(0, position), expected.Definition(0, position)) || !reflect.DeepEqual(patched.References(0, position, true), expected.References(0, position, true)) {
					t.Fatal("patched language query differs from full analysis")
				}
				if got := fmt.Sprint(original.Hover(0, position)); !strings.Contains(got, "number") {
					t.Fatal("immutable original index changed")
				}
			}
		}
	}
}
func TestLiteralProofRejectsDependenciesAndStructuralEdits(t *testing.T) {
	for _, suffix := range []string{
		"*print spare\n*ending",
		"*script stats.spare = 3;\n*ending",
		"*temp pointer \"spare\"\n*print {pointer}\n*ending",
		"*setref \"spare\" true\n*ending",
		"*temp_array other 3 true\n*ending",
		"*unknown_command\n*ending",
	} {
		p := literalEditProject(t, "*create spare 1\n"+suffix, "", 1)
		if _, ok := p.PatchUnusedLiteral(0, 0, "*create spare 1", "*create spare true", 2); ok {
			t.Fatalf("dependency was ignored: %s", suffix)
		}
	}
	p := literalEditProject(t, "*create spare 1\n*ending", "*print spare\n*ending", 1)
	if _, ok := p.PatchUnusedLiteral(0, 0, "*create spare 1", "*create spare true", 2); ok {
		t.Fatal("another scene dependency was ignored")
	}
	p = literalEditProject(t, "*create spare 1\n*ending", "", 1)
	for _, text := range []string{" *create spare 2", "*create other 2", "*set spare 2", "*create spare (2+3)", "*create spare \"unterminated", "*create spare true\nNew line"} {
		if _, ok := p.PatchUnusedLiteral(0, 0, "*create spare 1", text, 2); ok {
			t.Fatalf("structural edit accepted: %s", text)
		}
	}
	p = literalEditProject(t, "*create implicit_control_flow true\n*ending", "", 1)
	if _, ok := p.PatchUnusedLiteral(0, 0, "*create implicit_control_flow true", "*create implicit_control_flow false", 2); ok {
		t.Fatal("implicit interpreter input was treated as unused")
	}
}
