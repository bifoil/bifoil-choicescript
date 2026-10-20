package core

import (
	"io"
	"reflect"
	"strings"
	"testing"
)

func TestStreamingCompletionContextMatchesFullPrefixPatterns(t *testing.T) {
	p := analyzeExample(t, "*create score 1\n*label again\n*set score 2\n*ending")
	for _, prefix := range []string{"", "*", "  *go", "\t*goto_scene ", "*gosub again", "Narrative *goto_scene other", "${score", "@!!{score", "${score} ordinary", "\u00a0*go", strings.Repeat("Original prose ", 10000) + "${score", strings.Repeat(" ", 100000) + "*go"} {
		position := Position{Line: 0, Character: units(prefix)}
		actual := p.CompletionsReader(0, position, func() io.RuneReader { return strings.NewReader(prefix) })
		expected := p.Completions(0, position, prefix)
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("streamed completion changed context for %q", prefix[:min(80, len(prefix))])
		}
	}
}
