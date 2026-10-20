package main

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

func sourceHasByte(word uint64, b byte) bool {
	const ones uint64 = 0x0101010101010101
	value := word ^ (ones * uint64(b))
	return (value-ones)&^value&(ones*0x80) != 0
}

// Resolve UTF-16 positions with bounded scratch space, even when a physical
// narrative paragraph is enormous. The immutable piece reader handles edits and
// UTF-8 split across backing pieces; no complete source line is materialized.
func (s *textStore) sourcePosition(position core.Position) (int64, error) {
	if int(position.Line) >= len(s.lines) {
		return 0, errors.New("line exceeds document")
	}
	start, end := s.lines[position.Line], s.size
	if int(position.Line)+1 < len(s.lines) {
		end = s.lines[position.Line+1]
	}
	return resolveSourcePosition(s, start, end, position.Character)
}
func resolveSourcePosition(source io.ReaderAt, start, end int64, character uint32) (int64, error) {
	remaining := character
	if remaining == 0 {
		return start, nil
	}
	size := int(min(int64(65536), int64(remaining)*4+4))
	reader := bufio.NewReaderSize(io.NewSectionReader(source, start, end-start), max(64, size))
	consumed := int64(0)
	for remaining != 0 {
		if _, err := reader.Peek(1); err != nil {
			if errors.Is(err, io.EOF) {
				return 0, errors.New("column exceeds line")
			}
			return 0, err
		}
		chunk, _ := reader.Peek(reader.Buffered())
		limit := min(len(chunk), int(remaining))
		plain := 0
		for plain+8 <= limit {
			word := binary.LittleEndian.Uint64(chunk[plain : plain+8])
			if word&0x8080808080808080 != 0 || sourceHasByte(word, '\r') || sourceHasByte(word, '\n') {
				break
			}
			plain += 8
		}
		for plain < limit && chunk[plain] < 0x80 && chunk[plain] != '\r' && chunk[plain] != '\n' {
			plain++
		}
		if plain != 0 {
			_, _ = reader.Discard(plain)
			remaining -= uint32(plain)
			consumed += int64(plain)
			continue
		}
		r, bytes, err := reader.ReadRune()
		if err != nil {
			return 0, err
		}
		if r == '\r' || r == '\n' {
			return 0, errors.New("column exceeds line")
		}
		units := uint32(1)
		if r > 0xffff {
			units = 2
		}
		if units > remaining {
			return 0, errors.New("position splits a UTF-16 surrogate pair")
		}
		remaining -= units
		consumed += int64(bytes)
	}
	return start + consumed, nil
}
