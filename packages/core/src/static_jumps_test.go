package core

import (
	"context"
	"reflect"
	"testing"
)

func TestLiteralJumpSpecializationMatchesEnvironmentResolution(t *testing.T) {
	cases := [][]string{
		{"*create flag false\n*create implicit_control_flow true\n*if flag\n  *gosub_scene helper SPEAK\n*else\n  *gosub_scene helper second\n*ending", "*label speak\nFirst.\n*return\n*label second\nSecond.\n*return"},
		{"*create dest \"helper\"\n*create labelname \"speak\"\n*gosub_scene {dest} {labelname}\n*set labelname \"second\"\n*gosub_scene {dest} {labelname}\n*ending", "*label speak\nFirst.\n*return\n*label second\nSecond.\n*return"},
		{"*create dest \"first\"\n*gotoref dest\n*label first\n*set dest \"second\"\n*gotoref dest\n*label second\nDone.\n*ending"},
		{"*gosub_scene missing absent\n*goto_scene helper absent", "*label speak\n*return"},
		{"*gosub_scene helper \"speak\"\n*ending", "*label speak\n*return"},
	}
	for i, sources := range cases {
		build := func(reference bool) *Project {
			p := NewProject()
			p.disableStaticJumps = reference
			for j, text := range sources {
				scene := "startup"
				if j > 0 {
					scene = "helper"
				}
				p.AddSource(Source{URI: "file:///original/" + scene + ".txt", Text: text})
			}
			if err := p.Analyze(context.Background()); err != nil {
				t.Fatal(err)
			}
			return p
		}
		actual, want := build(false), build(true)
		if !reflect.DeepEqual(actual.Tokens, want.Tokens) || !reflect.DeepEqual(actual.Symbols, want.Symbols) || !reflect.DeepEqual(actual.SymbolValues, want.SymbolValues) {
			t.Fatalf("case %d: classifications or navigation differ", i)
		}
		for j := range actual.Documents {
			if !reflect.DeepEqual(actual.Documents[j].Diagnostics, want.Documents[j].Diagnostics) {
				t.Fatalf("case %d: diagnostics differ", i)
			}
		}
	}
}
