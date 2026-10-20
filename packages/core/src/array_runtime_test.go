package core

import (
	"fmt"
	"strings"
	"testing"
)

// These original examples follow defineArray/delete_array in the pinned engine.
// Array storage is a family of ordinary variables, not a resizable container.
func TestArrayRedeclarationPreservesRuntimeBindings(t *testing.T) {
	for _, test := range []struct {
		name, source, read string
		kind               uint8
	}{
		{"shorter default preserves old tail", "*temp_array items 4 true\n*temp_array items 2 1", "items_4", BooleanVariable},
		{"shorter default replaces old override", "*temp_array items 4 true\n*set items_1 \"old\"\n*temp_array items 2 1", "items_1", NumberVariable},
		{"later initializer sees earlier write", "*temp_array items 2 true\n*temp_array items 2 1 items_1", "items_2", NumberVariable},
		{"initializer sees old count", "*temp_array items 4 true\n*temp_array items 2 items_count items_count", "items_1", NumberVariable},
		{"delete respects current count", "*temp_array items 4 true\n*temp_array items 2 1\n*delete_array items", "items_4", BooleanVariable},
		{"delete preserves nested property", "*temp items_1_2 \"nested\"\n*temp_array items 2 1\n*delete_array items", "items_1_2", StringVariable},
		{"scalar base does not choose element scope", "*create items true\n*create_array items 2 1\n*temp items \"scalar\"", "items[1]", NumberVariable},
		{"unknown string subscript includes named fields", "*create items_named true\n*create_array items 2 1\n*temp selector \"named\"\n*input_text selector", "items[selector]", Variable},
	} {
		t.Run(test.name, func(t *testing.T) {
			text := test.source + "\n*print " + test.read + "\n*ending"
			p := analyzeExample(t, text)
			if got := nativeClassification(t, p, 0, text, "*print "+test.read); got != test.kind {
				t.Fatalf("got %s, want %s", TokenTypes[got], TokenTypes[test.kind])
			}
		})
	}
}
func TestArrayInitializerReadsCountBeforeFinalCountWrite(t *testing.T) {
	text := "*temp expected_4 true\n*temp expected_2 \"wrong\"\n*temp_array items 4 true\n*temp_array items 2 items_count items_count\n*print expected[items_1]\n*ending"
	p := analyzeExample(t, text)
	if got := nativeClassification(t, p, 0, text, "*print expected[items_1]"); got != BooleanVariable {
		t.Fatalf("initializer read new count: %s", TokenTypes[got])
	}
}
func TestArrayLargeExplicitInitializerKeepsCompleteAnalysis(t *testing.T) {
	var source strings.Builder
	source.WriteString("*temp_array items 18000")
	for i := range 18000 {
		if i%2 == 0 {
			source.WriteString(" 1")
		} else {
			source.WriteString(" true")
		}
	}
	source.WriteString("\n*print items[18000]\n*ending")
	text := source.String()
	p := analyzeExample(t, text)
	if got := nativeClassification(t, p, 0, text, "*print items[18000]"); got != BooleanVariable {
		t.Fatal(fmt.Sprint("last explicit initializer: ", TokenTypes[got]))
	}
}

func TestScalarAndArrayBasesHaveIndependentNavigation(t *testing.T) {
	text := "*create items true\n*create_array items 2 1\n*temp items \"local scalar\"\n*print items\n*print items[1]\n*ending"
	p := analyzeExample(t, text)
	if hasDiagnostic(p.Documents[0], "duplicate-symbol") {
		t.Fatal("array base collided with independent scalar")
	}
	scalar := p.Definition(0, Position{Line: 3, Character: 8})
	element := p.Definition(0, Position{Line: 4, Character: 8})
	if scalar == nil || scalar.Range.Start.Line != 2 || element == nil || element.Range.Start.Line != 1 {
		t.Fatalf("scalar=%v, array=%v", scalar, element)
	}
	scalarRefs := p.References(0, Position{Line: 3, Character: 8}, true)
	for _, reference := range scalarRefs {
		if reference.Range.Start.Line == 4 {
			t.Fatal("scalar rename captured an unrelated array reference")
		}
	}
}
func TestArrayPrefixFactsSurviveBranchesAndSubroutines(t *testing.T) {
	for _, body := range []string{
		"*if choice_nightmode\n  *temp_array items 2 1\n*print items_4\n*ending",
		"*gosub shrink\n*print items_4\n*ending\n*label shrink\n*temp_array items 2 1\n*return",
		"*gosub shrink\n*print items_4\n*ending\n*label shrink\n*temp_array items 2 1\n*delete_array items\n*return",
	} {
		text := "*create implicit_control_flow true\n*temp_array items 4 true\n" + body
		p := analyzeExample(t, text)
		if got := nativeClassification(t, p, 0, text, "*print items_4"); got != BooleanVariable {
			t.Fatalf("tail lost across branch/call: %s", TokenTypes[got])
		}
	}
}

func TestDynamicArrayWriteUsesEachMembersRuntimeScope(t *testing.T) {
	text := "*create items_named true\n*create_array items 2 1\n*temp_array items 2 true\n*temp selector \"named\"\n*input_text selector\n*set items[selector] \"changed\"\n*print items_named\n*ending"
	p := analyzeExample(t, text)
	if got := nativeClassification(t, p, 0, text, "*print items_named"); got != Variable {
		t.Fatalf("global named field escaped possible write: %s", TokenTypes[got])
	}
}

func TestDeleteArrayReferencesTheIndependentArrayDeclaration(t *testing.T) {
	text := "*create items true\n*create_array items 2 1\n*delete_array items\n*ending"
	p := analyzeExample(t, text)
	location := p.Definition(0, Position{Line: 2, Character: 15})
	if location == nil || location.Range.Start.Line != 1 {
		t.Fatal("delete_array resolved its scalar base", location)
	}
}
func TestDeleteArrayMergesBothPossibleCountScopes(t *testing.T) {
	text := "*create implicit_control_flow true\n*create_array items 2 1\n*if choice_nightmode\n  *temp_array items 2 true\n*delete_array items\n*print items_1\n*ending"
	p := analyzeExample(t, text)
	if got := nativeClassification(t, p, 0, text, "*print items_1"); got != Variable {
		t.Fatalf("ambiguous delete invented a definite surviving binding: %s", TokenTypes[got])
	}
}
func TestArrayRenameRefusesIndependentNamedPropertyCapture(t *testing.T) {
	text := "*create items_named true\n*create_array items 2 1\n*temp selector \"named\"\n*print items[selector]\n*ending"
	p := analyzeExample(t, text)
	if edit, err := p.Rename(0, Position{Line: 1, Character: 15}, "renamed"); err == nil && edit != nil {
		t.Fatal("array rename silently broke independent named-property access")
	}
}
