package core

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNativeNavigationRejectsAmbiguousNamesAndNonSymbols(t *testing.T) {
	source := "*create score 1\n*temp local true\n*create_array items 2 1\n*label entry\n*label other\n*print score\nOriginal prose.\n*ending"
	p := analyzeExample(t, source)
	for _, position := range []Position{{Line: 6, Character: 2}, {Line: 1000}, {Line: 5, Character: 1000}, {Line: 5, Character: 0}} {
		if p.Definition(0, position) != nil || len(p.References(0, position, true)) != 0 || p.PrepareRename(0, position) != nil {
			t.Fatal("non-symbol became a rename/navigation target", position)
		}
	}
	if p.TokenAt(999, Position{}) != nil || p.Hover(0, Position{Line: 1000}) != nil {
		t.Fatal("out-of-range position had hover")
	}
	if edit, err := p.Rename(0, Position{Line: 6, Character: 2}, "valid"); edit != nil || err != nil {
		t.Fatal("prose was renamed")
	}
	for _, name := range []string{"invalid-name", "choice_fake", "local", "items_1", "items_count"} {
		if _, err := p.Rename(0, Position{Line: 5, Character: 8}, name); err == nil {
			t.Fatal("unsafe variable rename accepted", name)
		}
	}
	if _, err := p.Rename(0, Position{Line: 3, Character: 8}, "other"); err == nil {
		t.Fatal("duplicate label accepted")
	}
	edit, err := p.Rename(0, Position{Line: 3, Character: 8}, "new_entry")
	if err != nil || len(edit.Changes[p.Documents[0].URI]) != 1 {
		t.Fatal("unique label rename failed", edit, err)
	}
	if _, exists := p.DocumentIndex("file:///missing.txt"); exists {
		t.Fatal("missing document resolved")
	}
	for _, test := range []struct{ prefix, want string }{{"*goto en", "entry"}, {"*gosub en", "other"}, {"*goto_scene st", "startup"}, {"*gosub_scene st", "startup"}, {"*redirect_scene st", "startup"}} {
		found := false
		for _, candidate := range p.Completions(0, Position{Line: 5}, test.prefix) {
			found = found || candidate.Label == test.want
		}
		if !found {
			t.Fatal("destination completion missing", test)
		}
	}
	for _, test := range []struct{ text, kind string }{{"*temp value true\n*print value", "boolean"}, {"*temp value \"text\"\n*print value", "string"}, {"*print undeclared", "unknown"}, {"*unknown_command", "ChoiceScript command"}} {
		project := analyzeExample(t, test.text)
		line, column := uint32(0), uint32(2)
		if strings.Contains(test.text, "\n") {
			line = 1
			column = 8
		} else if strings.Contains(test.text, "undeclared") {
			column = 8
		}
		hover := project.Hover(0, Position{Line: line, Character: column})
		bytes, _ := json.Marshal(hover)
		if !strings.Contains(string(bytes), test.kind) {
			t.Fatal("hover lost type/documentation", test, string(bytes))
		}
	}
}
