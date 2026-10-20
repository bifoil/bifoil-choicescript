package core

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func TestCompactedHeadersPreserveLateMetadataAndCode(t *testing.T) {
	text := "*create score 1\n" + strings.Repeat("Original paragraph.\n\n", 800) + "*stat_chart\n  percent score\n*fake_choice\n  #First\n    Original choice.\n  #Second\n    Other choice.\n*ending"
	actual, reference := NewProject(), NewProject()
	source := Source{URI: "file:///original/startup.txt", Text: text}
	actual.AddSource(source)
	source.denseRows = true
	reference.AddSource(source)
	if actual.Documents[0].rowKind(1603) != metadata {
		t.Fatal("stat-chart body did not retain its metadata kind")
	}
	if err := actual.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := reference.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual.Tokens, reference.Tokens) || !reflect.DeepEqual(actual.Documents[0].Diagnostics, reference.Documents[0].Diagnostics) || !reflect.DeepEqual(actual.Folding(0), reference.Folding(0)) {
		t.Fatal("compact headers changed metadata or choice features")
	}
}
