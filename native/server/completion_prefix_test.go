package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

func TestCompletionPrefixForStringsStoresAndClosedFilesMatchesUTF16(t *testing.T) {
	for _, text := range []string{"", "\ufeffΩ😀 first\r\n*goto_scene helper\rLast\n", strings.Repeat("long ordinary prose", 5000) + "\r\n*go"} {
		file := filepath.Join(t.TempDir(), "startup.txt")
		if err := os.WriteFile(file, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
		stored := captureTestBuffer(t, text)
		stored.URI = pathURI(file)
		for line := range uint32(7) {
			for column := range uint32(25) {
				position := core.Position{Line: line, Character: column}
				_, expectedErr := textOffset(text, position)
				expected := prefixAt(text, position)
				for _, variant := range []struct {
					buffer openBuffer
					open   bool
				}{{openBuffer{Text: text}, true}, {stored, true}, {openBuffer{}, false}} {
					prefix, closeSource, err := newCompletionPrefix(context.Background(), pathURI(file), variant.buffer, variant.open, position)
					if (err == nil) != (expectedErr == nil) {
						t.Fatalf("completion position validity changed: %+v", position)
					}
					if err == nil {
						reader := prefix.runes()
						var result strings.Builder
						for {
							r, _, err := reader.ReadRune()
							if err == io.EOF {
								break
							}
							if err != nil {
								t.Fatal(err)
							}
							result.WriteRune(r)
						}
						if result.String() != expected {
							t.Fatal("completion prefix changed source context")
						}
					}
					closeSource()
				}
			}
		}
	}
}
func TestClosedLargeSceneCompletionDoesNotAllocateWholeSource(t *testing.T) {
	file := filepath.Join(t.TempDir(), "startup.txt")
	text := "*create score 1\n" + strings.Repeat("Original prose.\n", 600000) + "*goto_scene helper\n"
	if err := os.WriteFile(file, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	prefix, closeSource, err := newCompletionPrefix(context.Background(), pathURI(file), openBuffer{}, false, core.Position{Line: 600001, Character: 14})
	if err != nil {
		t.Fatal(err)
	}
	defer closeSource()
	var result strings.Builder
	reader := prefix.runes()
	for {
		r, _, err := reader.ReadRune()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		result.WriteRune(r)
	}
	runtime.ReadMemStats(&after)
	if result.String() != "*goto_scene he" {
		t.Fatal("closed-scene completion used wrong line", result.String())
	}
	if after.TotalAlloc-before.TotalAlloc > 1024*1024 {
		t.Fatalf("completion allocated source-sized storage: %d", after.TotalAlloc-before.TotalAlloc)
	}
}
