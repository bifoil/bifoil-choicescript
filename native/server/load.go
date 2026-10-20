package main

import (
	"context"
	"crypto/sha256"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

// Parse workers never execute imported source. The bounded queue limits transient
// source buffers; all scene bytes leave the loader after lossless compaction.
func loadDirectory(root string, p *core.Project) (int64, int, int, error) {
	return loadDirectoryBuffers(context.Background(), root, p, nil)
}
func loadDirectoryBuffers(ctx context.Context, root string, p *core.Project, buffers map[string]openBuffer, caches ...*parseCache) (bytes int64, files, rows int, err error) {
	var paths []string
	err = filepath.WalkDir(root, func(file string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if e := ctx.Err(); e != nil {
			return e
		}
		if entry.IsDir() {
			if file != root && strings.HasPrefix(entry.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Type().IsRegular() && strings.EqualFold(filepath.Ext(file), ".txt") {
			paths = append(paths, file)
		}
		return nil
	})
	if err != nil {
		return
	}
	// Unsaved new scene files are part of the current project snapshot too.
	// Existing URI aliases must not duplicate a physical file, including case
	// variants on Windows volumes which may themselves be case-sensitive.
	known := make(map[string]bool, len(paths))
	for _, file := range paths {
		known[filepath.Clean(file)] = true
	}
	for uri := range buffers {
		file, e := uriPath(uri)
		if e != nil || !inside(root, file) || !strings.EqualFold(filepath.Ext(file), ".txt") || known[filepath.Clean(file)] {
			continue
		}
		duplicate := false
		if info, e := os.Stat(file); e == nil {
			if !info.Mode().IsRegular() {
				continue
			}
			for _, candidate := range paths {
				if !strings.EqualFold(filepath.Base(candidate), filepath.Base(file)) {
					continue
				}
				if other, e := os.Stat(candidate); e == nil && os.SameFile(info, other) {
					duplicate = true
					break
				}
			}
		}
		if !duplicate {
			paths = append(paths, file)
			known[filepath.Clean(file)] = true
		}
	}
	sort.Strings(paths)
	type result struct {
		index  int
		parsed *core.ParsedSource
		bytes  int
		err    error
	}
	workers := min(4, runtime.GOMAXPROCS(0), len(paths))
	jobs := make(chan int, workers)
	results := make(chan result, workers)
	for range workers {
		go func() {
			for index := range jobs {
				file := paths[index]
				if e := ctx.Err(); e != nil {
					results <- result{index: index, err: e}
					continue
				}
				var cache *parseCache
				if len(caches) > 0 {
					cache = caches[0]
				}
				parsed, size, e := parseNativeSource(ctx, file, buffers, cache)
				results <- result{index: index, parsed: parsed, bytes: size, err: e}
			}
		}()
	}
	pending := make(map[int]result)
	next, dispatched := 0, 0
	dispatch := func() {
		for dispatched < len(paths) && dispatched < next+workers*2 {
			jobs <- dispatched
			dispatched++
		}
	}
	dispatch()
	for range paths {
		r := <-results
		pending[r.index] = r
		for {
			r, ok := pending[next]
			if !ok {
				break
			}
			delete(pending, next)
			next++
			if r.err != nil {
				if err == nil {
					err = r.err
				}
				continue
			}
			d := p.AddParsed(r.parsed)
			bytes += int64(r.bytes)
			files++
			rows += d.RowCount() - 1
		}
		dispatch()
	}
	close(jobs)
	return
}

// Large files stay on disk throughout source capture and lexical analysis.
func parseNativeSource(ctx context.Context, file string, buffers map[string]openBuffer, cache *parseCache) (*core.ParsedSource, int, error) {
	if buffer, ok := latestNativeBuffer(file, buffers); ok && buffer.Store != nil {
		identity := core.Source{URI: buffer.URI, Version: buffer.Version}
		var parsed *core.ParsedSource
		var err error
		if cache != nil {
			parsed, err = cache.loadReader(ctx, identity, buffer.Store.reader(), buffer.Store.size)
		} else {
			parsed, err = core.ParseSourceReaderContext(ctx, identity, contextSourceReader{ctx, buffer.Store.reader()})
		}
		return parsed, int(buffer.Store.size), err
	}
	buffered := false
	for uri := range buffers {
		candidate, e := uriPath(uri)
		if e == nil && strings.EqualFold(filepath.Base(candidate), filepath.Base(file)) {
			buffered = true
			break
		}
	}
	if !buffered && cache != nil {
		finish := cache.beginDisk(pathURI(file))
		defer finish()
	}
	var diskInfo os.FileInfo
	var source core.Source
	var err error
	if !buffered {
		input, err := os.Open(file)
		if err != nil {
			return nil, 0, err
		}
		info, err := input.Stat()
		if err != nil {
			_ = input.Close()
			return nil, 0, err
		}
		diskInfo = info
		if info.Size() > 1024*1024 {
			defer input.Close()
			source := core.Source{URI: pathURI(file)}
			var digest sourceDigest
			var parsed *core.ParsedSource
			if cache != nil {
				parsed, err = cache.loadReader(ctx, source, input, info.Size(), &digest)
			} else {
				count := 1024
				if info.Size() > 8*1024*1024 {
					count, err = core.CountSourceLines(ctx, input)
				}
				if err == nil {
					parsed, err = core.ParseSourceReaderContext(ctx, source, contextSourceReader{ctx, input}, count)
				}
			}
			if err == nil && cache != nil {
				if after, e := input.Stat(); e == nil && sameDiskSnapshot(info, after) && digest.known {
					cache.recordDisk(source.URI, info, digest.digest)
				}
			}
			return parsed, int(info.Size()), err
		}
		data, readErr := readSmallSource(ctx, input, info.Size())
		closeErr := input.Close()
		if readErr != nil {
			return nil, 0, readErr
		}
		if closeErr != nil {
			return nil, 0, closeErr
		}
		source = core.Source{URI: pathURI(file), Text: string(data)}
	} else {
		source, err = readNativeSource(file, buffers)
		if err != nil {
			return nil, 0, err
		}
	}
	var parsed *core.ParsedSource
	if cache != nil {
		parsed, err = cache.load(ctx, source)
	} else {
		parsed, err = core.ParseSourceContext(ctx, source)
	}
	if err == nil && !buffered && cache != nil {
		if info, e := os.Stat(file); e == nil && sameDiskSnapshot(diskInfo, info) {
			cache.recordDisk(source.URI, diskInfo, sha256.Sum256([]byte(source.Text)))
		}
	}
	return parsed, len(source.Text), err
}

func readNativeSource(file string, buffers map[string]openBuffer) (core.Source, error) {
	absolute, err := filepath.Abs(file)
	if err != nil {
		return core.Source{}, err
	}
	if buffer, ok := latestNativeBuffer(absolute, buffers); ok {
		return core.Source{URI: buffer.URI, Text: buffer.Text, Version: buffer.Version}, nil
	}
	data, err := os.ReadFile(absolute)
	if err != nil {
		return core.Source{}, err
	}
	return core.Source{URI: pathURI(absolute), Text: string(data)}, nil
}

// URI aliases use physical identity, preserving distinct files in directories
// whose filesystem is case-sensitive even on Windows.
func nativeDocumentIndex(p *core.Project, uri string) (uint32, bool) {
	if doc, ok := p.DocumentIndex(uri); ok {
		return doc, true
	}
	file, err := uriPath(uri)
	if err != nil {
		return 0, false
	}
	var info os.FileInfo
	for i, d := range p.Documents {
		candidate, e := uriPath(d.URI)
		if e != nil || !strings.EqualFold(filepath.Base(candidate), filepath.Base(file)) {
			continue
		}
		if info == nil {
			info, err = os.Stat(file)
			if err != nil {
				return 0, false
			}
		}
		other, e := os.Stat(candidate)
		if e == nil && os.SameFile(info, other) {
			return uint32(i), true
		}
	}
	return 0, false
}

func sameDiskSnapshot(before, after os.FileInfo) bool {
	return before != nil && after != nil && os.SameFile(before, after) && before.Size() == after.Size() && before.ModTime().Equal(after.ModTime())
}

// Reuse the already opened/stat'ed scene rather than closing and reopening it.
// A spare byte detects growth; a changing file is still read through EOF, and
// the existing before/after identity check controls cache fingerprint reuse.
func readSmallSource(ctx context.Context, source *os.File, size int64) ([]byte, error) {
	data := make([]byte, 0, int(size)+1)
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if len(data) == cap(data) {
			data = append(data, 0)
			data = data[:len(data)-1]
		}
		n, err := source.Read(data[len(data):cap(data)])
		data = data[:len(data)+n]
		if err == io.EOF {
			return data, nil
		}
		if err != nil {
			return nil, err
		}
	}
}
