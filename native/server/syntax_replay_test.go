package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

func replayProject(t *testing.T, parsed *core.ParsedSource) *core.Project {
	t.Helper()
	p := core.NewProject()
	p.AddParsed(parsed)
	if err := p.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	p.CompactForQueries()
	return p
}
func TestRepeatedSyntaxEditsKeepCompleteCurrentFlowAndBoundedHistory(t *testing.T) {
	ctx := t.Context()
	cache := newParseCache(ctx, t.TempDir())
	defer cache.close()
	uri := "file:///original/startup.txt"
	text := "*create score 1\r\n*create implicit_control_flow true\r\nShe said \"Hello,\r\n*if score = 1\r\n  Friend.\"\r\n*else\r\n  World.\"\r\n" + strings.Repeat("Original narrative.\r\n\r\n", 1100) + "*print score\r\n*ending"
	source := core.Source{URI: uri, Text: text, Version: 1}
	baseline := core.ParseSource(source)
	key := sha256.Sum256([]byte(text))
	cache.write(baseline, key)
	baseline.Discard()
	sizeBefore, err := cache.file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	before := captureTestBuffer(t, text)
	before.URI = uri
	before.Version = 1
	for version := int32(2); version <= 101; version++ {
		old, _ := boundedRecipeLine(before, 0)
		literal := fmt.Sprintf("%d", version)
		if version%2 == 0 {
			literal = `"quoted \" reply"`
		}
		changes := []textChange{{Range: &core.Range{Start: core.Position{Character: 14}, End: core.Position{Character: uint32(len(old))}}, Text: literal}}
		after, err := changeBuffer(before, version, changes)
		if err != nil {
			t.Fatal(err)
		}
		cache.recordEdits(before, after, changes)
		parsed, err := cache.replay(ctx, core.Source{URI: uri, Version: version})
		if err != nil || parsed == nil {
			t.Fatalf("revision %d was not replayed: %v", version, err)
		}
		actual := replayProject(t, parsed)
		freshText := strings.Replace(text, "*create score 1", "*create score "+literal, 1)
		expected := replayProject(t, core.ParseSource(core.Source{URI: uri, Version: version, Text: freshText}))
		if !reflect.DeepEqual(actual.Tokens, expected.Tokens) || !reflect.DeepEqual(actual.Documents, expected.Documents) || !reflect.DeepEqual(actual.Symbols, expected.Symbols) {
			t.Fatalf("revision %d differs from full fresh analysis", version)
		}
		if len(cache.pending[uri].lines) != 1 || cache.recipeBytes > 512 {
			t.Fatal("replay retained edit history")
		}
		before = after
	}
	sizeAfter, err := cache.file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if sizeAfter.Size() != sizeBefore.Size() {
		t.Fatal("replay appended full lexical revisions")
	}
	if parsed, err := cache.replay(ctx, core.Source{URI: uri, Version: 100}); parsed != nil || err != nil {
		t.Fatal("replayed wrong version", err)
	}
	changes := []textChange{{Range: &core.Range{Start: core.Position{}, End: core.Position{}}, Text: "\n"}}
	after, err := changeBuffer(before, 102, changes)
	if err != nil {
		t.Fatal(err)
	}
	cache.recordEdits(before, after, changes)
	if len(cache.pending) != 0 || cache.recipeBytes != 0 {
		t.Fatal("structural edit retained old lexical recipe")
	}
}
func TestSyntaxCacheCompactionReadersAndEvictionPreserveSemantics(t *testing.T) {
	ctx := t.Context()
	cache := newParseCache(ctx, t.TempDir())
	defer cache.close()
	cache.limit = 12000
	var workers sync.WaitGroup
	failures := make(chan error, 4)
	for worker := range 4 {
		workers.Go(func() {
			for revision := range 30 {
				text := fmt.Sprintf("*create score %d\n", worker*100+revision) + strings.Repeat("Original prose.\n", 30) + "*print score\n*ending"
				identity := core.Source{URI: fmt.Sprintf("file:///original/%d/startup.txt", worker), Text: text, Version: int32(revision)}
				parsed := core.ParseSource(identity)
				key := sha256.Sum256([]byte(text))
				cache.write(parsed, key)
				parsed.Discard()
				cached, err := cache.find(ctx, key, identity)
				if err != nil {
					failures <- err
					return
				}
				// Another writer may evict this optional record between write and find.
				if cached == nil {
					cached = core.ParseSource(identity)
				}
				p := core.NewProject()
				p.AddParsed(cached)
				if err = p.Analyze(ctx); err != nil {
					failures <- err
					return
				}
				if p.Documents[0].Version != int32(revision) || len(p.Tokens[0]) == 0 {
					failures <- fmt.Errorf("cache lost current semantics")
					return
				}
			}
		})
	}
	workers.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	info, err := os.Stat(cache.file.Name())
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() > cache.limit || cache.disabled {
		t.Fatalf("cache not bounded: %d disabled=%v", info.Size(), cache.disabled)
	}
}
func TestSyntaxReplayMultipleLinesAndObsoleteCompletion(t *testing.T) {
	ctx := t.Context()
	cache := newParseCache(ctx, t.TempDir())
	defer cache.close()
	text := "*create score 1\nOriginal narrative.\n*print score\n*ending"
	uri := "file:///original/startup.txt"
	key := sha256.Sum256([]byte(text))
	parsed := core.ParseSource(core.Source{URI: uri, Text: text})
	cache.write(parsed, key)
	parsed.Discard()
	before := openBuffer{URI: uri, Text: text, Version: 1}
	for i, change := range []textChange{
		{Range: &core.Range{Start: core.Position{Character: 14}, End: core.Position{Character: 15}}, Text: "true"},
		{Range: &core.Range{Start: core.Position{Line: 1, Character: 8}, End: core.Position{Line: 1, Character: 8}}, Text: " Ω😀 extra"},
	} {
		after, err := changeBuffer(before, int32(i+2), []textChange{change})
		if err != nil {
			t.Fatal(err)
		}
		cache.recordEdits(before, after, []textChange{change})
		before = after
	}
	// A previously cancelled parse completing late cannot erase a newer recipe.
	late, loadErr := cache.load(ctx, core.Source{URI: uri, Version: 100, Text: strings.Replace(text, "score 1", "score true", 1)})
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	late.Discard()
	result, err := cache.replay(ctx, core.Source{URI: uri, Version: 3})
	if err != nil || result == nil {
		t.Fatal("newer pending recipe erased", err)
	}
	actual := replayProject(t, result)
	expected := replayProject(t, core.ParseSource(core.Source{URI: uri, Text: before.Text, Version: 3}))
	if !reflect.DeepEqual(actual.Documents, expected.Documents) || !reflect.DeepEqual(actual.Tokens, expected.Tokens) {
		t.Fatal("multiple line replay differs")
	}
	cancelled, stop := context.WithCancel(ctx)
	stop()
	if _, err = cache.replay(cancelled, core.Source{URI: uri, Version: 3}); err != context.Canceled {
		t.Fatal("cancelled replay succeeded", err)
	}
}

func TestReopenedVersionCannotAdoptDifferentSourceHash(t *testing.T) {
	ctx := t.Context()
	cache := newParseCache(ctx, t.TempDir())
	defer cache.close()
	uri := "file:///original/startup.txt"
	original := "*create score 1\n*create name \"old\"\n*print score\n*print name\n*ending"
	baseline := core.ParseSource(core.Source{URI: uri, Text: original, Version: 1})
	key := sha256.Sum256([]byte(original))
	cache.write(baseline, key)
	baseline.Discard()
	// The URI and protocol version repeat, but another line has different facts.
	reopened := strings.Replace(original, `name "old"`, "name true", 1)
	before := openBuffer{URI: uri, Text: reopened, Version: 1}
	changes := []textChange{{Range: &core.Range{Start: core.Position{Character: 14}, End: core.Position{Character: 15}}, Text: "2"}}
	after, err := changeBuffer(before, 2, changes)
	if err != nil {
		t.Fatal(err)
	}
	cache.recordEdits(before, after, changes)
	if len(cache.pending) != 0 {
		t.Fatal("reused an unrelated prior session")
	}
	parsed, err := cache.load(ctx, core.Source{URI: uri, Version: 2, Text: after.Text})
	if err != nil {
		t.Fatal(err)
	}
	actual := replayProject(t, parsed)
	fresh := replayProject(t, core.ParseSource(core.Source{URI: uri, Version: 2, Text: after.Text}))
	if !reflect.DeepEqual(actual.Documents, fresh.Documents) || !reflect.DeepEqual(actual.Tokens, fresh.Tokens) {
		t.Fatal("reopening returned obsolete source facts")
	}
}
func TestEditedStoreHashWitnessBelongsToTheExactImmutableStore(t *testing.T) {
	ctx := t.Context()
	cache := newParseCache(ctx, t.TempDir())
	defer cache.close()
	uri := "file:///original/startup.txt"
	text := "*create score 1\n*print score\n*ending"
	before := captureTestBuffer(t, text)
	before.URI = uri
	change := textChange{Range: &core.Range{Start: core.Position{Line: 1}, End: core.Position{Line: 1}}, Text: "Original.\n"}
	edited, err := changeBuffer(before, 2, []textChange{change})
	if err != nil {
		t.Fatal(err)
	}
	identity := core.Source{URI: uri, Version: 2}
	parsed, err := cache.loadReader(ctx, identity, edited.Store.reader(), edited.Store.size)
	if err != nil {
		t.Fatal(err)
	}
	var encoded strings.Builder
	if err = parsed.WriteParsed(&encoded); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(bufferContents(t, edited)))
	cache.write(parsed, digest)
	parsed.Discard()
	if got, known := cache.sourceDigests[edited.Store.identity]; !known || got != digest {
		t.Fatal("missing exact store hash witness")
	}
	changes := []textChange{{Range: &core.Range{Start: core.Position{Character: 14}, End: core.Position{Character: 15}}, Text: "true"}}
	after, err := changeBuffer(edited, 3, changes)
	if err != nil {
		t.Fatal(err)
	}
	cache.recordEdits(edited, after, changes)
	replayed, err := cache.replay(ctx, core.Source{URI: uri, Version: 3})
	if err != nil || replayed == nil {
		t.Fatal("exact edited-store baseline did not replay", err)
	}
	replayed.Discard()
	cache.forgetEdits(uri)
	unrelated, err := changeBuffer(before, 2, []textChange{{Range: &core.Range{Start: core.Position{Line: 1}, End: core.Position{Line: 1}}, Text: "Different.\n"}})
	if err != nil {
		t.Fatal(err)
	}
	newer, err := changeBuffer(unrelated, 3, changes)
	if err != nil {
		t.Fatal(err)
	}
	cache.recordEdits(unrelated, newer, changes)
	if len(cache.pending) != 0 {
		t.Fatal("another immutable store adopted this hash witness")
	}
	for i := uint64(1); i <= 2048; i++ {
		cache.rememberStoreDigest(i+100000, digest)
	}
	if len(cache.sourceDigests) > 1024 {
		t.Fatal("immutable hash witnesses retained unbounded history")
	}
}

func TestReplayFallsBackAfterInvalidatedBaseOrUnsupportedEdits(t *testing.T) {
	ctx := t.Context()
	cache := newParseCache(ctx, t.TempDir())
	defer cache.close()
	uri := "file:///original/startup.txt"
	source := "*create score 1\n*print score\n*ending"
	baseline := core.ParseSource(core.Source{URI: uri, Text: source, Version: 1})
	key := sha256.Sum256([]byte(source))
	cache.write(baseline, key)
	baseline.Discard()
	before := openBuffer{URI: uri, Version: 1, Text: source}
	change := textChange{Range: &core.Range{Start: core.Position{Character: 14}, End: core.Position{Character: 15}}, Text: "true"}
	after, err := changeBuffer(before, 2, []textChange{change})
	if err != nil {
		t.Fatal(err)
	}
	cache.recordEdits(before, after, []textChange{change})
	if len(cache.pending) != 1 {
		t.Fatal("valid edit was not retained")
	}
	cache.directoryMu.Lock()
	delete(cache.entries, key)
	cache.directoryMu.Unlock()
	if parsed, err := cache.replay(ctx, core.Source{URI: uri, Version: 2}); parsed != nil || err != nil {
		t.Fatal("missing optional baseline did not request full parsing", err)
	}
	for _, changes := range [][]textChange{nil, {change, change}, {{Text: "complete replacement"}}, {{Range: change.Range, Text: "new\nline"}}, {{Range: &core.Range{Start: core.Position{}, End: core.Position{Line: 1}}}}} {
		cache.recordEdits(before, after, changes)
		if len(cache.pending) != 0 || cache.recipeBytes != 0 {
			t.Fatal("unsupported edit retained obsolete recipe")
		}
	}
	large := openBuffer{URI: uri, Text: strings.Repeat("x", syntaxRecipeLineLimit+1)}
	if _, ok := boundedRecipeLine(large, 0); ok {
		t.Fatal("oversized line retained in recipe")
	}
	captured := captureTestBuffer(t, large.Text)
	if _, ok := boundedRecipeLine(captured, 0); ok {
		t.Fatal("oversized capture retained in recipe")
	}
	if _, ok := boundedRecipeLine(captured, 100); ok {
		t.Fatal("missing captured line was accepted")
	}
	var absent *parseCache
	absent.forgetEdits(uri)
	absent.recordEdits(before, after, []textChange{change})
}
