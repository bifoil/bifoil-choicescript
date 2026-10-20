package main

import (
	"reflect"
	"strings"
	"testing"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

type measuredCaptureReader struct {
	*textStoreReader
	readBytes int
}

func (r *measuredCaptureReader) Read(data []byte) (int, error) {
	n, err := r.textStoreReader.Read(data)
	r.readBytes += n
	return n, err
}
func TestCapturedFingerprintsAndEditedPieceTablesKeepCompleteSemantics(t *testing.T) {
	ctx := t.Context()
	cache := newParseCache(ctx, t.TempDir())
	defer cache.close()
	// Keep this test's cache writes synchronous so its next lookup definitely
	// exercises the already persisted record, rather than racing the writer.
	cache.slots <- struct{}{}
	defer func() { <-cache.slots }()
	original := "*create score 1\nOriginal narrative.\n*print score\n*ending\n"
	capture := captureTestBuffer(t, original)
	identity := core.Source{URI: "file:///original/startup.txt", Version: 1}
	first := &measuredCaptureReader{textStoreReader: capture.Store.reader()}
	parsed, err := cache.loadReader(ctx, identity, first, capture.Store.size)
	if err != nil {
		t.Fatal(err)
	}
	if first.readBytes != len(original) {
		t.Fatalf("initial capture read %d bytes, expected one complete pass", first.readBytes)
	}
	p := core.NewProject()
	p.AddParsed(parsed)
	if err = p.Analyze(ctx); err != nil {
		t.Fatal(err)
	}
	again := &measuredCaptureReader{textStoreReader: capture.Store.reader()}
	if _, err = cache.loadReader(ctx, identity, again, capture.Store.size); err != nil {
		t.Fatal(err)
	}
	if again.readBytes != 0 {
		t.Fatal("verified immutable capture was read again before cache lookup")
	}
	replacement := captureTestBuffer(t, "\"changed\"")
	edited, err := capture.Store.replaceStore(core.Range{Start: core.Position{Line: 0, Character: 14}, End: core.Position{Line: 0, Character: 15}}, replacement.Store)
	if err != nil {
		t.Fatal(err)
	}
	if edited.hasDigest {
		t.Fatal("edited bytes inherited the old fingerprint")
	}
	changed := &measuredCaptureReader{textStoreReader: edited.reader()}
	identity.Version = 2
	parsed, err = cache.loadReader(ctx, identity, changed, edited.size)
	if err != nil {
		t.Fatal(err)
	}
	if int64(changed.readBytes) != edited.size {
		t.Fatalf("edited capture read %d/%d bytes", changed.readBytes, edited.size)
	}
	actual, expected := core.NewProject(), core.NewProject()
	actual.AddParsed(parsed)
	identity.Text = strings.Replace(original, "score 1", "score \"changed\"", 1)
	expected.AddSource(identity)
	for _, project := range []*core.Project{actual, expected} {
		if err = project.Analyze(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(actual.Tokens, expected.Tokens) || !reflect.DeepEqual(actual.Documents[0].Diagnostics, expected.Documents[0].Diagnostics) {
		t.Fatal("single-pass edited capture changed complete analysis")
	}
}
