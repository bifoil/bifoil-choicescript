package main

import (
	"errors"
	"strings"
	"unicode/utf8"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

type openBuffer struct {
	Explicit bool       `json:"-"`
	Order    uint64     `json:"-"`
	Store    *textStore `json:"-"`
	URI      string     `json:"uri"`
	Text     string     `json:"text"`
	Version  int32      `json:"version"`
}
type textChange struct {
	Store *textStore  `json:"-"`
	Range *core.Range `json:"range"`
	Text  string      `json:"text"`
}

func textOffset(text string, position core.Position) (int, error) {
	line := uint32(0)
	start := 0
	for line < position.Line && start < len(text) {
		at := strings.IndexAny(text[start:], "\r\n")
		if at < 0 {
			return 0, errors.New("line exceeds document")
		}
		at += start
		start = at + 1
		if text[at] == '\r' && start < len(text) && text[start] == '\n' {
			start++
		}
		line++
	}
	if line != position.Line {
		return 0, errors.New("line exceeds document")
	}
	column := uint32(0)
	for start < len(text) && column < position.Character {
		r, width := utf8.DecodeRuneInString(text[start:])
		if r == '\r' || r == '\n' {
			return 0, errors.New("column exceeds line")
		}
		units := uint32(1)
		if r > 0xffff {
			units = 2
		}
		if column+units > position.Character {
			return 0, errors.New("position splits a UTF-16 surrogate pair")
		}
		column += units
		start += width
	}
	if column != position.Character {
		return 0, errors.New("column exceeds document")
	}
	return start, nil
}
func changeBuffer(buffer openBuffer, version int32, changes []textChange) (openBuffer, error) {
	if version <= buffer.Version {
		return buffer, errors.New("document version did not advance")
	}
	current := buffer
	for _, change := range changes {
		if change.Range == nil {
			current.Text = change.Text
			current.Store = change.Store
			continue
		}
		if current.Store != nil || change.Store != nil {
			store := current.Store
			if store == nil {
				store = newTextStore([]textPiece{{text: current.Text, size: int64(len(current.Text))}})
				var err error
				store.lines, err = physicalLineOffsets(store.reader())
				if err != nil {
					return buffer, err
				}
			}
			replacement := change.Store
			if replacement == nil {
				replacement = newTextStore([]textPiece{{text: change.Text, size: int64(len(change.Text))}})
			}
			next, err := store.replaceStore(*change.Range, replacement)
			if err != nil {
				return buffer, err
			}
			current.Store = next
			current.Text = ""
			continue
		}
		start, err := textOffset(current.Text, change.Range.Start)
		if err != nil {
			return buffer, err
		}
		end, err := textOffset(current.Text, change.Range.End)
		if err != nil {
			return buffer, err
		}
		if end < start {
			return buffer, errors.New("edit range is reversed")
		}
		current.Text = current.Text[:start] + change.Text + current.Text[end:]
	}
	current.Version = version
	return current, nil
}

func prefixAt(text string, position core.Position) string {
	offset, err := textOffset(text, position)
	if err != nil {
		return ""
	}
	start := strings.LastIndexAny(text[:offset], "\r\n") + 1
	return text[start:offset]
}
