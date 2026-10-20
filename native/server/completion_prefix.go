package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

type completionPrefix struct {
	ctx        context.Context
	source     io.ReaderAt
	start, end int64
	failure    error
}
type completionRuneReader struct {
	reader *bufio.Reader
	owner  *completionPrefix
}

func (r *completionRuneReader) ReadRune() (rune, int, error) {
	value, size, err := r.reader.ReadRune()
	if err != nil && !errors.Is(err, io.EOF) && r.owner.failure == nil {
		r.owner.failure = err
	}
	return value, size, err
}
func (p *completionPrefix) runes() io.RuneReader {
	return &completionRuneReader{bufio.NewReaderSize(contextSourceReader{p.ctx, io.NewSectionReader(p.source, p.start, p.end-p.start)}, 4096), p}
}
func newCompletionPrefix(ctx context.Context, uri string, buffer openBuffer, open bool, position core.Position) (*completionPrefix, func(), error) {
	closeSource := func() {}
	prefix := &completionPrefix{ctx: ctx}
	if open && buffer.Store != nil {
		end, err := buffer.Store.position(position)
		if err != nil {
			return nil, closeSource, err
		}
		prefix.source, prefix.start, prefix.end = buffer.Store, buffer.Store.lines[position.Line], end
		return prefix, closeSource, nil
	}
	if open {
		start, err := textOffset(buffer.Text, core.Position{Line: position.Line})
		if err != nil {
			return nil, closeSource, err
		}
		end, err := textOffset(buffer.Text, position)
		if err != nil {
			return nil, closeSource, err
		}
		prefix.source, prefix.start, prefix.end = strings.NewReader(buffer.Text), int64(start), int64(end)
		return prefix, closeSource, nil
	}
	name, err := uriPath(uri)
	if err != nil {
		return nil, closeSource, err
	}
	file, err := os.Open(name)
	if err != nil {
		return nil, closeSource, err
	}
	closeSource = func() { _ = file.Close() }
	info, err := file.Stat()
	if err != nil {
		closeSource()
		return nil, func() {}, err
	}
	start, err := physicalLineStart(ctx, file, info.Size(), position.Line)
	if err != nil {
		closeSource()
		return nil, func() {}, err
	}
	end, err := resolveSourcePosition(file, start, info.Size(), position.Character)
	if err != nil {
		closeSource()
		return nil, func() {}, err
	}
	prefix.source, prefix.start, prefix.end = file, start, end
	return prefix, closeSource, nil
}

// Closed scenes do not have an editor line table. Locate only the requested
// physical line in bounded chunks; CR, LF, CRLF and an empty final line agree
// with the parser and immutable editor buffers. The borrowed file is never
// registered as an owned capture or passed to a deletion path.
func physicalLineStart(ctx context.Context, source io.ReaderAt, size int64, target uint32) (int64, error) {
	if target == 0 {
		return 0, nil
	}
	buffer := make([]byte, 65536)
	var line uint32
	var start int64
	afterCR := false
	for offset := int64(0); offset < size; {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		n, err := source.ReadAt(buffer[:min(int64(len(buffer)), size-offset)], offset)
		if err != nil && !errors.Is(err, io.EOF) {
			return 0, err
		}
		if n == 0 {
			return 0, io.ErrNoProgress
		}
		data := buffer[:n]
		at := 0
		for at < len(data) {
			if afterCR {
				afterCR = false
				if data[at] == '\n' {
					at++
					start = offset + int64(at)
				}
				if line == target {
					return start, nil
				}
			}
			if at == len(data) {
				break
			}
			rest := data[at:]
			next := bytes.IndexByte(rest, '\n')
			before := rest
			if next >= 0 {
				before = rest[:next+1]
			}
			if cr := bytes.IndexByte(before, '\r'); cr >= 0 {
				next = cr
			}
			if next < 0 {
				break
			}
			at += next + 1
			line++
			start = offset + int64(at)
			afterCR = data[at-1] == '\r'
			if line == target && !afterCR {
				return start, nil
			}
		}
		offset += int64(n)
	}
	if line == target {
		return start, nil
	}
	return 0, errors.New("line exceeds document")
}
