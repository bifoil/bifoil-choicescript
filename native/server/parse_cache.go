package main

import (
	"context"
	"crypto/sha256"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

type parseWrite struct {
	parsed *core.ParsedSource
	key    [32]byte
}
type parseLocation struct{ offset, size int64 }

// The session cache uses one bounded, owned file. A small hash directory is
// published only after each complete record has been written. This avoids a
// create/open/rename cycle for every scene while retaining byte-addressed syntax,
// bounded outstanding writes, and complete semantic recomputation after edits.
type parseCache struct {
	ctx           context.Context
	file          *os.File
	directoryMu   sync.RWMutex
	entries       map[[32]byte]parseLocation
	seenSources   map[string]bool
	sourceDigests map[uint64][32]byte
	digestOrder   [1024]uint64
	digestCursor  uint32
	pending       map[string]syntaxRecipe
	recipeBytes   int64
	limit         int64
	disabled      bool
	diskSources   map[string]diskSource
	diskPending   map[string]chan struct{}
	writeMu       sync.Mutex
	offset        int64
	jobs          chan parseWrite
	slots         chan struct{}
	worker        sync.WaitGroup
}

func newParseCache(ctx context.Context, directory string) *parseCache {
	cache := &parseCache{ctx: ctx, entries: make(map[[32]byte]parseLocation), seenSources: make(map[string]bool), sourceDigests: make(map[uint64][32]byte), pending: make(map[string]syntaxRecipe), limit: 256 * 1024 * 1024, diskSources: make(map[string]diskSource), diskPending: make(map[string]chan struct{}), jobs: make(chan parseWrite, 1), slots: make(chan struct{}, 1)}
	if os.MkdirAll(directory, 0700) == nil {
		cache.file, _ = os.OpenFile(filepath.Join(directory, "syntax.bin"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	}
	cache.worker.Go(func() {
		for write := range cache.jobs {
			if ctx.Err() == nil {
				cache.write(write.parsed, write.key)
			}
			write.parsed.Discard()
			write.parsed = nil
			<-cache.slots
		}
	})
	return cache
}
func (c *parseCache) close() {
	close(c.jobs)
	c.worker.Wait()
	if c.file != nil {
		_ = c.file.Close()
	}
}
func (c *parseCache) find(ctx context.Context, key [32]byte, identity core.Source) (*core.ParsedSource, error) {
	if c.file == nil {
		return nil, nil
	}
	c.directoryMu.RLock()
	defer c.directoryMu.RUnlock()
	location, found := c.entries[key]
	if !found || c.disabled {
		return nil, nil
	}
	parsed, err := core.ReadParsed(sizedContextSourceReader{contextSourceReader{ctx, io.NewSectionReader(c.file, location.offset, location.size)}, location.size}, identity)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, nil
	} // A failed cache record is reparsed; analysis is never reduced.
	if err = ctx.Err(); err != nil {
		parsed.Discard()
		return nil, err
	}
	return parsed, nil
}
func (c *parseCache) load(ctx context.Context, source core.Source) (*core.ParsedSource, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if os.Getenv("BIFOIL_NATIVE_DISABLE_PARSE_CACHE") != "" {
		return core.ParseSourceContext(ctx, source)
	}
	if parsed, err := c.replay(ctx, source); parsed != nil || err != nil {
		return parsed, err
	}
	key := sha256.Sum256([]byte(source.Text))
	if parsed, err := c.find(ctx, key, source); parsed != nil || err != nil {
		return parsed, err
	}
	parsed, err := core.ParseSourceContext(ctx, source)
	if err != nil {
		return nil, err
	}
	return c.store(ctx, parsed, key, true)
}
func (c *parseCache) store(ctx context.Context, parsed *core.ParsedSource, key [32]byte, asynchronous bool) (*core.ParsedSource, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if c.file == nil {
		return parsed, nil
	}
	if asynchronous && parsed.TransferCopyBytes() <= 8*1024*1024 {
		select {
		case c.slots <- struct{}{}:
			transfer := parsed.CloneForTransfer()
			c.jobs <- parseWrite{parsed, key}
			return transfer, nil
		default:
		}
	}
	c.write(parsed, key)
	return parsed, nil
}
func (c *parseCache) loadReader(ctx context.Context, identity core.Source, reader io.ReadSeeker, size int64, digests ...*sourceDigest) (*core.ParsedSource, error) {
	sourceID := uint64(0)
	if source, ok := reader.(interface{ SourceIdentity() uint64 }); ok {
		sourceID = source.SourceIdentity()
	}
	remember := func(key [32]byte) {
		c.rememberStoreDigest(sourceID, key)
		for _, output := range digests {
			*output = sourceDigest{key, true}
		}
	}

	if os.Getenv("BIFOIL_NATIVE_DISABLE_PARSE_CACHE") == "" {
		if parsed, err := c.replay(ctx, identity); parsed != nil || err != nil {
			return parsed, err
		}
	}
	parse := func(input io.Reader) (*core.ParsedSource, error) {
		began := time.Now()
		counted := began
		defer func() {
			if size > 8*1024*1024 && os.Getenv("BIFOIL_NATIVE_TIMINGS") != "" {
				writeStderrf("native lexical bytes=%d reader=%T count=%.1f parse=%.1f\n", size, reader, float64(counted.Sub(began).Microseconds())/1000, float64(time.Since(counted).Microseconds())/1000)
			}
		}()
		if size <= 8*1024*1024 {
			return core.ParseSourceReaderContext(ctx, identity, input)
		}
		count, err := core.CountSourceLines(ctx, reader)
		counted = time.Now()
		if err != nil {
			return nil, err
		}
		return core.ParseSourceReaderContext(ctx, identity, input, count)
	}
	if os.Getenv("BIFOIL_NATIVE_DISABLE_PARSE_CACHE") != "" {
		return parse(contextSourceReader{ctx, reader})
	}
	if c.file == nil {
		return parse(contextSourceReader{ctx, reader})
	}
	if captured, ok := reader.(interface{ SourceDigest() ([32]byte, bool) }); ok {
		if key, known := captured.SourceDigest(); known {
			remember(key)
			if parsed, err := c.find(ctx, key, identity); parsed != nil || err != nil {
				return parsed, err
			}
			parsed, err := parse(contextSourceReader{ctx, reader})
			if err != nil {
				return nil, err
			}
			return c.store(ctx, parsed, key, true)
		}
		// A changed immutable piece table cannot reuse its predecessor's hash.
		// Parse and fingerprint its exact new bytes in the same bounded pass.
		hash := sha256.New()
		parsed, err := parse(io.TeeReader(contextSourceReader{ctx, reader}, hash))
		if err != nil {
			return nil, err
		}
		var key [32]byte
		copy(key[:], hash.Sum(nil))
		remember(key)
		return c.store(ctx, parsed, key, true)
	}
	c.directoryMu.RLock()
	seen := c.seenSources[identity.URI]
	c.directoryMu.RUnlock()
	if !seen {
		hash := sha256.New()
		parsed, err := parse(io.TeeReader(contextSourceReader{ctx, reader}, hash))
		if err != nil {
			return nil, err
		}
		var key [32]byte
		copy(key[:], hash.Sum(nil))
		remember(key)
		c.directoryMu.Lock()
		c.seenSources[identity.URI] = true
		c.directoryMu.Unlock()
		return c.store(ctx, parsed, key, true)
	}
	hash := sha256.New()
	if _, err := io.CopyBuffer(hash, contextSourceReader{ctx, reader}, make([]byte, 65536)); err != nil {
		return nil, err
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	var key [32]byte
	copy(key[:], hash.Sum(nil))
	remember(key)
	if parsed, err := c.find(ctx, key, identity); parsed != nil || err != nil {
		return parsed, err
	}
	parsed, err := parse(contextSourceReader{ctx, reader})
	if err != nil {
		return nil, err
	}
	// Large IR remains single-owner while persisting, leaving headroom for tools.
	return c.store(ctx, parsed, key, true)
}

type countedParseWriter struct {
	destination io.Writer
	bytes       int64
}

func (w *countedParseWriter) Write(data []byte) (int, error) {
	n, err := w.destination.Write(data)
	w.bytes += int64(n)
	return n, err
}
func (c *parseCache) write(parsed *core.ParsedSource, key [32]byte) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.directoryMu.RLock()
	_, exists := c.entries[key]
	disabled := c.disabled
	c.directoryMu.RUnlock()
	if exists || disabled || c.file == nil {
		return
	}
	start := c.offset
	writer := &countedParseWriter{destination: c.file}
	if err := parsed.WriteParsed(writer); err != nil {
		_ = c.file.Truncate(start)
		_, _ = c.file.Seek(start, io.SeekStart)
		return
	}
	c.offset += writer.bytes
	c.directoryMu.Lock()
	c.entries[key] = parseLocation{start, writer.bytes}
	if c.offset > c.limit {
		c.compactLocked(key, parseLocation{start, writer.bytes})
	}
	c.directoryMu.Unlock()
}

type contextSourceReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextSourceReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

type diskSource struct {
	digest [32]byte
	info   os.FileInfo
}

type sourceDigest struct {
	digest [32]byte
	known  bool
}

// Store identities name immutable versions without retaining their backing files
// or offset arrays. A bounded ring keeps optional hash witnesses finite.
func (c *parseCache) rememberStoreDigest(identity uint64, digest [32]byte) {
	if identity == 0 {
		return
	}
	c.directoryMu.Lock()
	defer c.directoryMu.Unlock()
	if _, known := c.sourceDigests[identity]; !known {
		old := c.digestOrder[c.digestCursor]
		delete(c.sourceDigests, old)
		c.digestOrder[c.digestCursor] = identity
		c.digestCursor = (c.digestCursor + 1) % uint32(len(c.digestOrder))
	}
	c.sourceDigests[identity] = digest
}
func (c *parseCache) recordDisk(uri string, info os.FileInfo, digest [32]byte) {
	c.directoryMu.Lock()
	defer c.directoryMu.Unlock()
	c.diskSources[uri] = diskSource{digest, info}
}
func (c *parseCache) diskMatch(buffer openBuffer, name string) (bool, bool) {
	if buffer.Store == nil || !buffer.Store.hasDigest {
		return false, false
	}
	c.directoryMu.RLock()
	source, found := c.diskSources[buffer.URI]
	c.directoryMu.RUnlock()
	if !found {
		return false, false
	}
	live, err := os.Stat(name)
	if err != nil || !os.SameFile(source.info, live) || source.info.Size() != live.Size() || !source.info.ModTime().Equal(live.ModTime()) {
		return false, false
	}
	return source.digest == buffer.Store.digest, true
}
func (s *nativeServer) bufferMatchesFile(buffer openBuffer, name string) bool {
	if s.parseCache != nil {
		if match, known := s.parseCache.diskMatch(buffer, name); known {
			return match
		}
		if buffer.Store != nil && buffer.Store.hasDigest {
			s.parseCache.waitDisk(buffer.URI)
			if match, known := s.parseCache.diskMatch(buffer, name); known {
				return match
			}
		}
	}
	return bufferMatchesFile(buffer, name)
}

func (c *parseCache) forgetDisk(uri string) {
	c.directoryMu.Lock()
	delete(c.diskSources, uri)
	c.directoryMu.Unlock()
}

// An open notification can arrive while its original disk snapshot is parsing.
// Share that in-flight fingerprint instead of competing with it through another
// full disk read. The existing load owns completion, including cancellation.
func (c *parseCache) beginDisk(uri string) func() {
	ready := make(chan struct{})
	c.directoryMu.Lock()
	c.diskPending[uri] = ready
	c.directoryMu.Unlock()
	return func() {
		c.directoryMu.Lock()
		if c.diskPending[uri] == ready {
			delete(c.diskPending, uri)
		}
		close(ready)
		c.directoryMu.Unlock()
	}
}
func (c *parseCache) waitDisk(uri string) {
	c.directoryMu.RLock()
	ready := c.diskPending[uri]
	c.directoryMu.RUnlock()
	if ready != nil {
		select {
		case <-ready:
		case <-c.ctx.Done():
		}
	}
}

// Preserve the record-length allocation guards while making cache IO cancellable.
type sizedContextSourceReader struct {
	contextSourceReader
	size int64
}

func (r sizedContextSourceReader) Size() int64 { return r.size }
