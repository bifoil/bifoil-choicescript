package core

import (
	"reflect"
	"strings"
	"testing"
)

func TestNativeProseEditMatchesFreshFullProject(t *testing.T) {
	cases := []struct {
		source      string
		line        uint32
		replacement string
	}{
		{"She said \"Hello,\n*temp gender \"male\"\nworld.\"\nDone.", 2, "dear world.\""},
		{"*create implicit_control_flow true\n*if true\n  She said \"Hello,\nAfter.", 3, "After all of this."},
		{"A closing quote ” here.\nDone.", 0, "A closing quote ” over here."},
		{"She said \"Hello,\nStill speaking.", 1, "Still speaking to you."},
		{"*temp score 1\nA plain sentence.\n*print score", 1, "A longer plain sentence with 😀."},
	}
	for _, tc := range cases {
		original := analyzeExample(t, tc.source)
		original.CompactForQueries()
		changed, ok := original.PatchPureProse(0, tc.line, tc.replacement, 2)
		if !ok {
			t.Fatal("equivalent prose edit rejected", tc.line)
		}
		lines := strings.Split(tc.source, "\n")
		lines[tc.line] = tc.replacement
		fresh := analyzeExample(t, strings.Join(lines, "\n"))
		if !reflect.DeepEqual(changed.Tokens, fresh.Tokens) || changed.WordCount(0) != fresh.WordCount(0) || !reflect.DeepEqual(changed.Documents[0].Diagnostics, fresh.Documents[0].Diagnostics) {
			t.Fatalf("incremental prose differs from complete analysis\n%v\n%v\n%v\n%v", changed.Tokens, fresh.Tokens, changed.Documents[0].Diagnostics, fresh.Documents[0].Diagnostics)
		}
		if original.Documents[0].Version == 2 {
			t.Fatal("edit mutated the previous immutable snapshot")
		}
	}
}
func TestNativeProseEditRejectsChangedQuoteFlowOrSyntax(t *testing.T) {
	original := analyzeExample(t, "She said \"Hello.\n*print true\nDone.")
	original.CompactForQueries()
	for _, text := range []string{"She said hello.", "*set state true", "${state}", "  She said \"Hello.", "She said \"Hello.\nMore."} {
		if _, ok := original.PatchPureProse(0, 0, text, 2); ok {
			t.Fatal("edit incorrectly bypassed full analysis", text)
		}
	}
}

func TestNativeNarrativeIslandEditsMatchFullAnalysis(t *testing.T) {
	cases := []struct {
		source string
		line   uint32
		after  string
	}{
		{"*temp name \"guest\"\nShe said \"Hello ${name}, dear friend.\"\nDone.", 1, "She said \"Hello ${name}, dearest friend.\""},
		{"*temp flag true\n@{flag Hello, dear friend|Goodbye, friend}.\nDone.", 1, "@{flag Hello, dearest friend|Goodbye, friend}."},
		{"She said [b]Hello, dear friend.[/b]\nDone.", 0, "She said [b]Hello, dearest friend.[/b]"},
		{"*temp name \"guest\"\nHello ${name}, how are you\nDone.", 1, "Hello ${name}, how are you today"},
	}
	for _, tc := range cases {
		original := analyzeExample(t, tc.source)
		original.CompactForQueries()
		lines := strings.Split(tc.source, "\n")
		changed, ok := original.PatchNarrativeSpan(0, tc.line, lines[tc.line], tc.after, 2)
		if !ok {
			t.Fatal("equivalent narrative edit was rejected", tc.after)
		}
		lines[tc.line] = tc.after
		fresh := analyzeExample(t, strings.Join(lines, "\n"))
		if !reflect.DeepEqual(changed.Tokens, fresh.Tokens) || changed.WordCount(0) != fresh.WordCount(0) || !reflect.DeepEqual(changed.Documents[0].Diagnostics, fresh.Documents[0].Diagnostics) {
			t.Fatalf("narrative edit differs from full analysis\n%v\n%v\n%v\n%v", changed.Tokens, fresh.Tokens, changed.Documents[0].Diagnostics, fresh.Documents[0].Diagnostics)
		}
	}
}
