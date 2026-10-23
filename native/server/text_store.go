package main

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"hash"
	"io"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

// A backing file is immutable. Buffer versions and in-flight analysis share it;
// cleanup runs only after the final referencing piece and reader are unreachable.
type textBacking struct{ file *os.File }
type backingCleanup struct {
	file  *os.File
	owner *captureOwner
}

// The registry owns only CreateTemp handles, allowing deterministic Windows
// handle cleanup after all request and analysis workers have stopped.
type captureOwner struct {
	mu     sync.Mutex
	files  map[*os.File]struct{}
	closed bool
}

func (o *captureOwner) register(file *os.File) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return errors.New("source capture owner is closed")
	}
	o.files[file] = struct{}{}
	return nil
}
func (o *captureOwner) release(file *os.File) {
	if o != nil {
		o.mu.Lock()
		delete(o.files, file)
		o.mu.Unlock()
	}
	_ = file.Close()
	_ = os.Remove(file.Name())
}
func (o *captureOwner) close() {
	o.mu.Lock()
	o.closed = true
	files := o.files
	o.files = nil
	o.mu.Unlock()
	for file := range files {
		_ = file.Close()
		_ = os.Remove(file.Name())
	}
}

// Captures own only files freshly created here. No source pathname can enter
// the deletion path; imported files are read by the loader and never adopted.
type sourceCapture struct {
	file                *os.File
	committed           bool
	owner               *captureOwner
	hasher              hash.Hash
	lines               []int64
	position, written   int64
	lastCR, streamIndex bool
}

func newSourceCapture(directory string, owners ...*captureOwner) (*sourceCapture, error) {
	file, err := os.CreateTemp(directory, "open-source-")
	if err != nil {
		return nil, err
	}
	var owner *captureOwner
	if len(owners) > 0 {
		owner = owners[0]
	}
	if owner != nil {
		if err := owner.register(file); err != nil {
			_ = file.Close()
			_ = os.Remove(file.Name())
			return nil, err
		}
	}
	return &sourceCapture{file: file, owner: owner, hasher: sha256.New(), lines: []int64{0}}, nil
}
func (c *sourceCapture) abort() {
	if !c.committed {
		c.owner.release(c.file)
	}
}
func (c *sourceCapture) finish() (*textStore, error) {
	info, err := c.file.Stat()
	if err != nil {
		return nil, err
	}
	backing := &textBacking{file: c.file}
	store := newTextStore([]textPiece{{backing: backing, size: info.Size()}})
	if info.Size() != c.written || c.position != c.written {
		return nil, errors.New("incomplete source capture")
	}
	store.lines = c.lines
	copy(store.digest[:], c.hasher.Sum(nil))
	store.hasDigest = true
	runtime.AddCleanup(backing, func(c backingCleanup) { c.owner.release(c.file) }, backingCleanup{c.file, c.owner})
	c.committed = true
	return store, nil
}

type textPiece struct {
	backing      *textBacking
	offset, size int64
	text         string
}

var sourceStoreSequence atomic.Uint64

type textStore struct {
	identity      uint64
	pieces        []textPiece
	starts, lines []int64
	size          int64
	digest        [32]byte
	hasDigest     bool
}

func newTextStore(pieces []textPiece) *textStore {
	store := &textStore{identity: sourceStoreSequence.Add(1)}
	for _, piece := range pieces {
		if piece.size == 0 {
			continue
		}
		// Adjacent slices of the same immutable backing remain one piece. Small
		// consecutive insertions also coalesce, bounding per-keystroke metadata.
		if len(store.pieces) > 0 {
			last := &store.pieces[len(store.pieces)-1]
			if last.backing == piece.backing && last.backing != nil && last.offset+last.size == piece.offset {
				last.size += piece.size
				store.size += piece.size
				continue
			}
			if last.backing == nil && piece.backing == nil && last.size+piece.size <= 65536 {
				last.text += piece.text
				last.size += piece.size
				store.size += piece.size
				continue
			}
		}
		store.starts = append(store.starts, store.size)
		store.pieces = append(store.pieces, piece)
		store.size += piece.size
	}
	return store
}
func (s *textStore) ReadAt(destination []byte, offset int64) (int, error) {
	if offset < 0 {
		return 0, errors.New("negative source offset")
	}
	if len(destination) == 0 {
		return 0, nil
	}
	if offset >= s.size {
		return 0, io.EOF
	}
	index := sort.Search(len(s.starts), func(i int) bool { return s.starts[i] > offset }) - 1
	written := 0
	for written < len(destination) && index < len(s.pieces) {
		piece := s.pieces[index]
		relative := offset - s.starts[index]
		length := min(int64(len(destination)-written), piece.size-relative)
		if piece.backing != nil {
			n, err := piece.backing.file.ReadAt(destination[written:written+int(length)], piece.offset+relative)
			runtime.KeepAlive(piece.backing)
			if int64(n) != length {
				if err == nil {
					err = io.ErrUnexpectedEOF
				}
				return written + n, err
			}
		} else {
			copy(destination[written:written+int(length)], piece.text[relative:relative+length])
		}
		written += int(length)
		offset += length
		index++
	}
	if written < len(destination) {
		return written, io.EOF
	}
	return written, nil
}

type textStoreReader struct {
	identity uint64
	*io.SectionReader
	lineCount int
	digest    [32]byte
	hasDigest bool
}

func (r *textStoreReader) PhysicalLineCount() int { return r.lineCount }

// SourceDigest fingerprints immutable owned captures, never a client-supplied
// pathname. Edited piece tables have no fingerprint until their new bytes are read.
func (r *textStoreReader) SourceDigest() ([32]byte, bool) { return r.digest, r.hasDigest }
func (s *textStore) reader() *textStoreReader {
	return &textStoreReader{identity: s.identity, SectionReader: io.NewSectionReader(s, 0, s.size), lineCount: len(s.lines), digest: s.digest, hasDigest: s.hasDigest}
}
func physicalLineOffsets(reader io.Reader) ([]int64, error) {
	offsets := []int64{0}
	buffer := make([]byte, 65536)
	position := int64(0)
	cr := false
	for {
		n, err := reader.Read(buffer)
		for _, b := range buffer[:n] {
			position++
			if b == '\n' {
				if cr {
					offsets[len(offsets)-1] = position
				} else {
					offsets = append(offsets, position)
				}
			} else if b == '\r' {
				offsets = append(offsets, position)
			}
			cr = b == '\r'
		}
		if errors.Is(err, io.EOF) {
			return offsets, nil
		}
		if err != nil {
			return nil, err
		}
	}
}

func (s *textStore) line(line uint32) (string, error) {
	if int(line) >= len(s.lines) {
		return "", errors.New("line exceeds document")
	}
	start, end := s.lines[line], s.size
	if int(line)+1 < len(s.lines) {
		end = s.lines[line+1]
	}
	data := make([]byte, end-start)
	if _, err := s.ReadAt(data, start); err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return strings.TrimSuffix(strings.TrimSuffix(string(data), "\n"), "\r"), nil
}
func (s *textStore) position(position core.Position) (int64, error) {
	return s.sourcePosition(position)
}

func (s *textStore) slice(start, end int64) []textPiece {
	var pieces []textPiece
	for i, piece := range s.pieces {
		left, right := max(start, s.starts[i]), min(end, s.starts[i]+piece.size)
		if left >= right {
			continue
		}
		relative := left - s.starts[i]
		piece.offset += relative
		piece.size = right - left
		if piece.backing == nil {
			piece.text = piece.text[relative : relative+piece.size]
		}
		pieces = append(pieces, piece)
	}
	return pieces
}
func (s *textStore) replaceStore(r core.Range, replacement *textStore) (*textStore, error) {
	start, err := s.position(r.Start)
	if err != nil {
		return nil, err
	}
	end, err := s.position(r.End)
	if err != nil {
		return nil, err
	}
	if end < start {
		return nil, errors.New("edit range is reversed")
	}
	pieces := s.slice(0, start)
	pieces = append(pieces, replacement.pieces...)
	pieces = append(pieces, s.slice(end, s.size)...)
	next := newTextStore(pieces)
	delta := replacement.size - (end - start)
	// Reindex the touched lines and their neighbors. Prefix and suffix line
	// offsets are reused; ordinary typing never rescans a giant source file.
	windowStart := s.lines[max(int(r.Start.Line)-1, 0)]
	windowEnd := s.size
	if int(r.End.Line)+2 < len(s.lines) {
		windowEnd = s.lines[r.End.Line+2]
	}
	middle, err := physicalLineOffsets(io.NewSectionReader(next, windowStart, windowEnd-windowStart+delta))
	if err != nil {
		return nil, err
	}
	next.lines = make([]int64, 0, len(s.lines)+len(middle))
	for _, offset := range s.lines {
		if offset >= windowStart {
			break
		}
		next.lines = append(next.lines, offset)
	}
	for _, offset := range middle {
		next.lines = append(next.lines, windowStart+offset)
	}
	for _, offset := range s.lines {
		if offset > windowEnd {
			next.lines = append(next.lines, offset+delta)
		}
	}
	return next, nil
}
func bufferReader(buffer openBuffer) io.Reader {
	if buffer.Store != nil {
		return buffer.Store.reader()
	}
	return strings.NewReader(buffer.Text)
}
func bufferLineText(buffer openBuffer, line uint32) (string, bool) {
	if buffer.Store != nil {
		text, err := buffer.Store.line(line)
		return text, err == nil
	}
	return bufferLine(buffer.Text, line)
}
func bufferMatchesFile(buffer openBuffer, name string) bool {
	file, err := os.Open(name)
	if err != nil {
		return false
	}
	defer closeNativeFile(file)
	left, right := make([]byte, 65536), make([]byte, 65536)
	source := bufferReader(buffer)
	for {
		n, a := io.ReadFull(file, left)
		m, b := io.ReadFull(source, right)
		if n != m || !bytes.Equal(left[:n], right[:m]) {
			return false
		}
		if a != nil || b != nil {
			return (errors.Is(a, io.EOF) || errors.Is(a, io.ErrUnexpectedEOF)) && (errors.Is(b, io.EOF) || errors.Is(b, io.ErrUnexpectedEOF))
		}
	}
}

func (c *sourceCapture) advanceRune(r rune) {
	width := int64(1)
	if r >= 0x80 {
		width = int64(utf8.RuneLen(r))
	}
	c.position += width
	if r == '\n' {
		if c.lastCR {
			c.lines[len(c.lines)-1] = c.position
		} else {
			c.lines = append(c.lines, c.position)
		}
	} else if r == '\r' {
		c.lines = append(c.lines, c.position)
	}
	c.lastCR = r == '\r'
}
func (c *sourceCapture) advancePlain(length int) {
	if length > 0 {
		c.position += int64(length)
		c.lastCR = false
	}
}
func (c *sourceCapture) Write(data []byte) (int, error) {
	n, err := c.file.Write(data)
	c.written += int64(n)
	_, _ = c.hasher.Write(data[:n])
	if !c.streamIndex {
		for _, b := range data[:n] {
			c.position++
			if b == '\n' {
				if c.lastCR {
					c.lines[len(c.lines)-1] = c.position
				} else {
					c.lines = append(c.lines, c.position)
				}
			} else if b == '\r' {
				c.lines = append(c.lines, c.position)
			}
			c.lastCR = b == '\r'
		}
	}
	return n, err
}

func (r *textStoreReader) SourceIdentity() uint64 { return r.identity }
