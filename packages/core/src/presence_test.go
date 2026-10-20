package core

import (
	"bytes"
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestMaybeAbsentLocalPreservesFallbackTypesAndBlocksAmbiguousRename(t *testing.T) {
	for _, test := range []struct {
		local string
		kind  uint8
	}{{"2", NumberVariable}, {"\"local\"", Variable}} {
		text := "*create implicit_control_flow true\n*create value 1\n*if choice_nightmode\n  *temp value " + test.local + "\n*print value\n*ending"
		p := analyzeExample(t, text)
		if got := nativeClassification(t, p, 0, text, "*print value"); got != test.kind {
			t.Errorf("local %s has type %d, want %d", test.local, got, test.kind)
		}
		if p.PrepareRename(0, Position{Line: 4, Character: 8}) != nil || p.PrepareRename(0, Position{Line: 1, Character: 9}) != nil {
			t.Error("ambiguous local/global binding allowed rename")
		}
	}
}
func TestDeletedVirtualLocalElementFallsBackToGlobal(t *testing.T) {
	text := "*create items_1 \"global\"\n*temp_array items 3 1\n*delete items_1\n*print items_1\n*ending"
	p := analyzeExample(t, text)
	if got := nativeClassification(t, p, 0, text, "*print items_1"); got != StringVariable {
		t.Fatalf("deleted virtual local came back as %s", TokenTypes[got])
	}
}
func TestScriptMayCreateOrDeleteLocalBindings(t *testing.T) {
	text := "*create value 1\n*script temps.value = \"dynamic\";\n*print value\n*temp value true\n*print value = true\n*ending"
	p := analyzeExample(t, text)
	if got := nativeClassification(t, p, 0, text, "*print value"); got != Variable {
		t.Fatalf("script local is %s", TokenTypes[got])
	}
	if p.PrepareRename(0, Position{Line: 2, Character: 8}) != nil {
		t.Fatal("script-dependent scope allowed rename")
	}
	if got := nativeClassification(t, p, 0, text, "*print value = true"); got != BooleanVariable {
		t.Fatalf("explicit post-script local is %s", TokenTypes[got])
	}
}

func TestOptionalBindingSurvivesCallsAndCachedQueries(t *testing.T) {
	text := "*create implicit_control_flow true\n*create value 1\n*if choice_nightmode\n  *temp value 2\n*gosub read\n*ending\n*label read\n*print value\n*return"
	p := analyzeExample(t, text)
	if got := nativeClassification(t, p, 0, text, "*print value"); got != NumberVariable {
		t.Fatal("call discarded the global fallback type")
	}
	p.CompactForQueries()
	var stored bytes.Buffer
	if err := p.WriteSnapshot(&stored); err != nil {
		t.Fatal(err)
	}
	loaded, err := ReadSnapshot(&stored)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.PrepareRename(0, Position{Line: 1, Character: 9}) != nil {
		t.Fatal("cached query lost ambiguous rename guard")
	}
}
func TestScriptBindingPresenceParticipatesInCallSummaries(t *testing.T) {
	text := "*create value 1\n*script temps.value = \"dynamic\";\n*gosub read\n*temp value true\n*gosub read\n*ending\n*label read\n*print value\n*return"
	p := analyzeExample(t, text)
	if got := nativeClassification(t, p, 0, text, "*print value"); got != Variable {
		t.Fatal("call summary inferred a type for a script-dependent binding")
	}
	if p.PrepareRename(0, Position{Line: 0, Character: 9}) != nil {
		t.Fatal("script-dependent call reference allowed rename")
	}
}

func TestAmbiguousScopeKeepsUsefulTypeHoverAndReferenceParity(t *testing.T) {
	text := "*create implicit_control_flow true\n*create value 1\n*if choice_nightmode\n  *temp value 2\n*print value\n*ending"
	actual, reference := NewProject(), NewProject()
	reference.disableTokenFacts = true
	source := Source{URI: "file:///original/startup.txt", Text: text}
	actual.AddSource(source)
	reference.AddSource(source)
	for _, p := range []*Project{actual, reference} {
		if err := p.Analyze(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(actual.Tokens, reference.Tokens) || !reflect.DeepEqual(actual.unsafeRenames, reference.unsafeRenames) {
		t.Fatal("compact scope facts differ from full environment observations")
	}
	hover := fmt.Sprint(actual.Hover(0, Position{Line: 4, Character: 8}))
	if !strings.Contains(hover, "number") {
		t.Fatal("known type hover missing for ambiguous scope")
	}
	if actual.Definition(0, Position{Line: 4, Character: 8}) != nil {
		t.Fatal("ambiguous reference invented a declaration")
	}
}
