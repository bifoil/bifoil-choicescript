package core

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The optional path supplies local read-only source for reproducible profiling.
// It is never embedded into test fixtures, logs, or distributed binaries.
func BenchmarkNativeParser(b *testing.B) {
	var sources []Source
	root := os.Getenv("BIFOIL_CHOICESCRIPT_BENCHMARK_PATH")
	if root != "" {
		err := filepath.WalkDir(root, func(file string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				if entry.Name()[0] == '.' && file != root {
					return filepath.SkipDir
				}
				return nil
			}
			if !entry.Type().IsRegular() || !strings.EqualFold(filepath.Ext(file), ".txt") {
				return nil
			}
			bytes, err := os.ReadFile(file)
			if err != nil {
				return err
			}
			sources = append(sources, Source{URI: filepath.ToSlash(file), Text: string(bytes)})
			return nil
		})
		if err != nil {
			b.Fatal(err)
		}
	} else {
		sources = []Source{{URI: "file:///original/scenes/startup.txt", Text: "*create value 1\n" + strings.Repeat("*set value +1\nShe said \"Hello.\"\n\n", 100000)}}
	}
	var bytes int
	for _, source := range sources {
		bytes += len(source.Text)
	}
	b.SetBytes(int64(bytes))
	b.ResetTimer()
	for range b.N {
		var names registry
		var values valuePool
		documents := make([]*Document, 0, len(sources))
		for index, source := range sources {
			documents = append(documents, parseSource(source, uint32(index+1), &names, &values))
		}
		b.StopTimer()
		runtime.GC()
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		b.ReportMetric(float64(memory.HeapAlloc)/1048576, "live-MiB")
		var rows, tokens, expressions int
		for _, doc := range documents {
			rows += doc.RowCount() - 1
			tokens += len(doc.Syntax) - 1
			expressions += len(doc.Exprs) - 1
		}
		b.ReportMetric(float64(rows), "rows")
		b.ReportMetric(float64(tokens), "tokens")
		b.ReportMetric(float64(expressions), "expressions")
		runtime.KeepAlive(documents)
		runtime.KeepAlive(names)
		runtime.KeepAlive(values)
		b.StartTimer()
	}
}
