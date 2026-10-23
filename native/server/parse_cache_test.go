package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

func TestParallelSyntaxCachePreservesCompleteReboundAnalysis(t *testing.T) {
	ctx := t.Context()
	cache := newParseCache(ctx, t.TempDir())
	defer cache.close()
	text := "*create score 1\r\n*create implicit_control_flow true\r\nShe said \"Hello,\r\n*if score = 1\r\n  Friend.\"\r\n*else\r\n  World.\"\r\n*set score \"unterminated\r\n"
	var workers sync.WaitGroup
	errors := make(chan error, 16)
	for worker := range 8 {
		workers.Go(func() {
			for revision := int32(1); revision <= 3; revision++ {
				identity := core.Source{URI: fmt.Sprintf("file:///original/%d/startup.txt", worker), Version: revision}
				parsed, err := cache.loadReader(ctx, identity, strings.NewReader(text), int64(len(text)))
				if err != nil {
					errors <- err
					return
				}
				p := core.NewProject()
				p.AddParsed(parsed)
				if err = p.Analyze(ctx); err != nil {
					errors <- err
					return
				}
				expected := core.NewProject()
				identity.Text = text
				expected.AddSource(identity)
				if err = expected.Analyze(ctx); err != nil {
					errors <- err
					return
				}
				if !reflect.DeepEqual(p.Tokens, expected.Tokens) || !reflect.DeepEqual(p.Documents[0].Diagnostics, expected.Documents[0].Diagnostics) || p.Documents[0].URI != identity.URI || p.Documents[0].Version != revision {
					errors <- fmt.Errorf("cache changed complete semantics for worker %d", worker)
					return
				}
			}
		})
	}
	workers.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
}

func TestDiskHashOptimizationNeverAdoptsUnsavedHashes(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "startup.txt")
	original := "*create score 1\nOriginal prose.\n"
	if err := os.WriteFile(file, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	cache := newParseCache(ctx, t.TempDir())
	defer cache.close()
	if _, _, err := parseNativeSource(ctx, file, nil, cache); err != nil {
		t.Fatal(err)
	}
	buffer := captureTestBuffer(t, original)
	buffer.URI = pathURI(file)
	if match, known := cache.diskMatch(buffer, file); !known || !match {
		t.Fatal("unchanged capture did not match")
	}
	edited := captureTestBuffer(t, strings.Replace(original, "score 1", "score 2", 1))
	edited.URI = buffer.URI
	if _, err := cache.loadReader(ctx, core.Source{URI: buffer.URI, Version: 2}, edited.Store.reader(), edited.Store.size); err != nil {
		t.Fatal(err)
	}
	if match, known := cache.diskMatch(edited, file); !known || match {
		t.Fatal("unsaved analysis replaced the disk fingerprint")
	}
	cache.forgetDisk(buffer.URI)
	if _, known := cache.diskMatch(buffer, file); known {
		t.Fatal("watcher invalidation retained fingerprint")
	}
}

func TestUnavailableAndCorruptSyntaxCachesKeepCompleteAnalysis(t *testing.T) {
	ctx := t.Context()
	source := core.Source{URI: "file:///original/startup.txt", Version: 7, Text: "*temp value 1\nShe said \"Original.\"\n*set value true\n*print value\n*ending"}
	expected := replayProject(t, core.ParseSource(source))
	for _, kind := range []string{"unavailable", "closed", "corrupt"} {
		t.Run(kind, func(t *testing.T) {
			directory := t.TempDir()
			if kind == "unavailable" {
				if err := os.WriteFile(filepath.Join(directory, "syntax.bin"), []byte("Caller-owned existing file"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			cache := newParseCache(ctx, directory)
			defer cache.close()
			if cache.file != nil {
				original := core.ParseSource(source)
				cache.write(original, sha256.Sum256([]byte(source.Text)))
				original.Discard()
				if kind == "closed" {
					if err := cache.file.Close(); err != nil {
						t.Fatal(err)
					}
				} else {
					if _, err := cache.file.WriteAt([]byte("corrupt"), 0); err != nil {
						t.Fatal(err)
					}
				}
			}
			actual, err := cache.load(ctx, source)
			if err != nil {
				t.Fatal("optional cache failure escaped", err)
			}
			project := replayProject(t, actual)
			if !reflect.DeepEqual(project.Tokens, expected.Tokens) || !reflect.DeepEqual(project.Symbols, expected.Symbols) || !reflect.DeepEqual(project.Documents[0].Diagnostics, expected.Documents[0].Diagnostics) {
				t.Fatal("cache fallback reduced or changed analysis")
			}
		})
	}
}

func TestSyntaxCacheCompactionFailuresKeepFreshAnalysisAvailable(t *testing.T) {
	source := core.Source{URI: "file:///original/startup.txt", Version: 3, Text: "*temp score 1\nShe said \"Original.\"\n*print score\n*ending"}
	expected := replayProject(t, core.ParseSource(source))
	for _, kind := range []string{"oversized", "closed", "read-only", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			cache := newParseCache(ctx, t.TempDir())
			defer cache.close()
			parsed := core.ParseSource(source)
			defer parsed.Discard()
			key := sha256.Sum256([]byte(source.Text))
			cache.write(parsed, key)
			location, found := cache.entries[key]
			if !found {
				t.Fatal("initial cache record was not written")
			}
			switch kind {
			case "oversized":
				cache.limit = 1
			case "closed":
				if err := cache.file.Close(); err != nil {
					t.Fatal(err)
				}
			case "read-only":
				name := cache.file.Name()
				if err := cache.file.Close(); err != nil {
					t.Fatal(err)
				}
				var err error
				cache.file, err = os.Open(name)
				if err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				cancel()
			}
			cache.directoryMu.Lock()
			cache.compactLocked(key, location)
			cache.directoryMu.Unlock()
			if len(cache.entries) != 0 {
				t.Fatal("unusable lexical records remained available")
			}
			actual, err := cache.load(t.Context(), source)
			if err != nil {
				t.Fatal("optional compaction failure blocked fresh parsing", err)
			}
			project := replayProject(t, actual)
			if !reflect.DeepEqual(project.Tokens, expected.Tokens) || !reflect.DeepEqual(project.Symbols, expected.Symbols) || !reflect.DeepEqual(project.Documents[0].Diagnostics, expected.Documents[0].Diagnostics) {
				t.Fatal("compaction fallback changed complete language results")
			}
		})
	}
}
