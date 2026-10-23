// Command bifoil-language-server hosts the shared native ChoiceScript service.
package main

import (
	"context"
	"encoding/json"
	"os"
	"runtime"
	"runtime/debug"
	"runtime/pprof"
	"strconv"
	"time"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

func main() {
	// Bound per-processor allocation caches and GC workers as well as the heap.
	// Parsing uses at most four workers; additional runtime processors increased
	// resident peaks and GC contention without useful analysis parallelism.
	runtime.GOMAXPROCS(min(4, runtime.GOMAXPROCS(0)))
	limit := int64(96)
	if value := os.Getenv("BIFOIL_NATIVE_MEMORY_LIMIT_MIB"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil || parsed < 32 || parsed > 192 {
			writeStderr("Invalid native memory target")
			os.Exit(2)
		}
		limit = parsed
	}
	debug.SetMemoryLimit(limit * 1024 * 1024)
	if len(os.Args) > 1 && os.Args[1] == "--stdio" {
		if path := os.Getenv("BIFOIL_NATIVE_CPU_PROFILE"); path != "" {
			file, err := os.Create(path)
			if err != nil {
				writeStderr(err)
				os.Exit(1)
			}
			if err = pprof.StartCPUProfile(file); err != nil {
				_ = file.Close()
				writeStderr(err)
				os.Exit(1)
			}
			defer func() { pprof.StopCPUProfile(); _ = file.Close() }()
		}
		options := nativeOptions{}
		for i := 2; i < len(os.Args); i += 2 {
			if i+1 >= len(os.Args) {
				writeStderr("Missing server option value")
				os.Exit(2)
			}
			switch os.Args[i] {
			case "--bundle-root":
				options.Bundle = os.Args[i+1]
			case "--node":
				options.Node = os.Args[i+1]
			default:
				writeStderr("Unknown server option")
				os.Exit(2)
			}
		}
		if err := serveNative(os.Stdin, os.Stdout, options); err != nil {
			writeStderr(err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 2 && os.Args[1] == "--analyze" {
		if err := analyzeDirectory(os.Args[2]); err != nil {
			writeStderr(err)
			os.Exit(1)
		}
		return
	}
	writeStderr("Use --analyze followed by a scene directory.")
	os.Exit(2)
}
func analyzeDirectory(root string) error {
	if file := os.Getenv("BIFOIL_NATIVE_CPU_PROFILE"); file != "" {
		f, err := os.Create(file)
		if err != nil {
			return err
		}
		defer closeNativeFile(f)
		if err := pprof.StartCPUProfile(f); err != nil {
			return err
		}
		defer pprof.StopCPUProfile()
	}
	started := time.Now()
	p := core.NewProject()
	sourceBytes, files, rows, err := loadDirectory(root, p)
	if err != nil {
		return err
	}
	parsed := time.Since(started)
	if os.Getenv("BIFOIL_NATIVE_TRACE") != "" {
		writeStderr("parsed", parsed)
	}
	ctx := context.Background()
	if duration := os.Getenv("BIFOIL_NATIVE_ANALYSIS_TIMEOUT"); duration != "" {
		limit, e := time.ParseDuration(duration)
		if e != nil {
			return e
		}
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, limit)
		defer cancel()
	}
	if os.Getenv("BIFOIL_NATIVE_TRACE") != "" {
		p.Trace = func(phase string, steps uint64, states, queue, contexts int) {
			writeStderr(phase, steps, states, queue, contexts)
		}
	}
	if err = p.Analyze(ctx); err != nil {
		return err
	}
	elapsed := time.Since(started)
	counts := map[string]int{}
	var words, tokens uint64
	invalidTokens := 0
	for index, d := range p.Documents {
		words += p.WordCount(uint32(index))
		for _, diagnostic := range d.Diagnostics {
			counts[diagnostic.Code]++
		}
		var previous core.Token
		hasPrevious := false
		for _, token := range p.Tokens[index] {
			tokens++
			if token.Length == 0 || int(token.Line) >= d.LineCount() || token.Start+token.Length > d.LineWidth(token.Line) || hasPrevious && (token.Line < previous.Line || token.Line == previous.Line && token.Start < previous.Start+previous.Length) {
				invalidTokens++
			}
			previous = token
			hasPrevious = true
		}
	}
	runtime.GC()
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	result := map[string]any{"files": files, "rows": rows, "sourceBytes": sourceBytes, "words": words, "tokens": tokens, "steps": p.Steps, "parseMs": float64(parsed.Microseconds()) / 1000, "totalMs": float64(elapsed.Microseconds()) / 1000, "liveMiB": float64(memory.HeapAlloc) / 1048576, "peakResidentMiB": peakResidentMiB(), "diagnostics": counts, "invalidTokens": invalidTokens}
	runtime.KeepAlive(p)
	return json.NewEncoder(os.Stdout).Encode(result)
}
