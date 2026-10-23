package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Large JSON-RPC source strings are decoded directly into server-owned captures.
// Their JSON placeholders exist only inside this reader; a client cannot supply
// a capture pathname. Ordinary LSP framing and document versions are unchanged.
type sourceJSON struct {
	input     *bufio.Reader
	output    bytes.Buffer
	directory string
	sources   map[string]*textStore
	owner     *captureOwner
}

func (s *rpcStream) readSourceFrame(length int) (rpcMessage, error) {
	limited := &io.LimitedReader{R: s.reader, N: int64(length)}
	decoder := sourceJSON{input: bufio.NewReaderSize(limited, 65536), directory: s.textDirectory, sources: make(map[string]*textStore), owner: s.captures}
	var message rpcMessage
	if err := decoder.value("", 0); err != nil {
		return message, err
	}
	if err := decoder.space(); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("trailing JSON-RPC data")
		}
		return message, err
	}
	if limited.N != 0 {
		return message, io.ErrUnexpectedEOF
	}
	if err := json.Unmarshal(decoder.output.Bytes(), &message); err != nil {
		return message, err
	}
	if message.JSONRPC != "2.0" {
		return message, errors.New("expected JSON-RPC 2.0")
	}
	message.Sources = decoder.sources
	return message, nil
}
func (d *sourceJSON) space() error {
	for {
		b, err := d.input.ReadByte()
		if err != nil {
			return err
		}
		if b != ' ' && b != '\n' && b != '\r' && b != '\t' {
			return d.input.UnreadByte()
		}
	}
}
func pointerPart(key string) string {
	return strings.ReplaceAll(strings.ReplaceAll(key, "~", "~0"), "/", "~1")
}
func sourcePath(path string) bool {
	if path == "/params/textDocument/text" {
		return true
	}
	const prefix = "/params/contentChanges/"
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, "/text") {
		return false
	}
	_, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimPrefix(path, prefix), "/text"), 10, 32)
	return err == nil
}
func (d *sourceJSON) quoted() ([]byte, error) {
	var raw bytes.Buffer
	raw.WriteByte('"')
	escaped := false
	for {
		b, err := d.input.ReadByte()
		if err != nil {
			return nil, err
		}
		raw.WriteByte(b)
		if raw.Len() > 16*1024*1024 {
			return nil, errors.New("JSON-RPC metadata string is too large")
		}
		if b == '"' && !escaped {
			return raw.Bytes(), nil
		}
		if b == '\\' && !escaped {
			escaped = true
		} else {
			escaped = false
		}
	}
}
func (d *sourceJSON) value(path string, depth int) error {
	if depth > 10000 {
		return errors.New("JSON-RPC nesting exceeds JSON limit")
	}
	if err := d.space(); err != nil {
		return err
	}
	// Duplicate object members follow encoding/json's last-value rule, including
	// replacing a complete parent object after a previous captured descendant.
	for key := range d.sources {
		if key == path || strings.HasPrefix(key, path+"/") {
			delete(d.sources, key)
		}
	}
	b, err := d.input.ReadByte()
	if err != nil {
		return err
	}
	switch b {
	case '"':
		if sourcePath(path) {
			capture, err := newSourceCapture(d.directory, d.owner)
			if err != nil {
				return err
			}
			defer capture.abort()
			writer := bufio.NewWriterSize(capture, 65536)
			if err = decodeSourceString(d.input, writer, capture); err != nil {
				return err
			}
			if err = writer.Flush(); err != nil {
				return err
			}
			store, err := capture.finish()
			if err != nil {
				return err
			}
			d.sources[path] = store
			d.output.WriteString(`""`)
		} else {
			raw, err := d.quoted()
			if err != nil {
				return err
			}
			d.output.Write(raw)
		}
	case '{', '[':
		d.output.WriteByte(b)
		closeSource := byte('}')
		if b == '[' {
			closeSource = ']'
		}
		if err := d.space(); err != nil {
			return err
		}
		next, err := d.input.ReadByte()
		if err != nil {
			return err
		}
		if next == closeSource {
			d.output.WriteByte(closeSource)
			break
		}
		_ = d.input.UnreadByte()
		for index := 0; ; index++ {
			child := path + "/" + strconv.Itoa(index)
			if b == '{' {
				if err := d.space(); err != nil {
					return err
				}
				quote, err := d.input.ReadByte()
				if err != nil {
					return err
				}
				if quote != '"' {
					return errors.New("expected JSON object key")
				}
				raw, err := d.quoted()
				if err != nil {
					return err
				}
				var key string
				if err = json.Unmarshal(raw, &key); err != nil {
					return err
				}
				d.output.Write(raw)
				if err := d.space(); err != nil {
					return err
				}
				colon, err := d.input.ReadByte()
				if err != nil {
					return err
				}
				if colon != ':' {
					return errors.New("expected JSON colon")
				}
				d.output.WriteByte(':')
				child = path + "/" + pointerPart(key)
			}
			if err := d.value(child, depth+1); err != nil {
				return err
			}
			if err := d.space(); err != nil {
				return err
			}
			delimiter, err := d.input.ReadByte()
			if err != nil {
				return err
			}
			d.output.WriteByte(delimiter)
			if delimiter == closeSource {
				break
			}
			if delimiter != ',' {
				return errors.New("expected JSON delimiter")
			}
		}
	default:
		d.output.WriteByte(b)
		for {
			next, err := d.input.ReadByte()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return err
			}
			if next == ',' || next == '}' || next == ']' || next == ' ' || next == '\n' || next == '\r' || next == '\t' {
				_ = d.input.UnreadByte()
				break
			}
			d.output.WriteByte(next)
			if d.output.Len() > 16*1024*1024 {
				return errors.New("JSON-RPC metadata is too large")
			}
		}
	}
	if d.output.Len() > 16*1024*1024 {
		return errors.New("JSON-RPC metadata is too large")
	}
	return nil
}
func decodeSourceString(input *bufio.Reader, output *bufio.Writer, capture *sourceCapture) error {
	capture.streamIndex = true
	var high rune
	flushHigh := func() error {
		if high != 0 {
			high = 0
			capture.advanceRune(utf8.RuneError)
			_, err := output.WriteRune(utf8.RuneError)
			return err
		}
		return nil
	}
	emit := func(r rune) error {
		if high != 0 {
			if r >= 0xdc00 && r <= 0xdfff {
				r = utf16.DecodeRune(high, r)
				high = 0
			} else if err := flushHigh(); err != nil {
				return err
			}
		}
		if r >= 0xd800 && r <= 0xdbff {
			high = r
			return nil
		}
		if r >= 0xdc00 && r <= 0xdfff {
			r = utf8.RuneError
		}
		capture.advanceRune(r)
		_, err := output.WriteRune(r)
		return err
	}
	for {
		if _, err := input.Peek(1); err != nil {
			return err
		}
		chunk, _ := input.Peek(input.Buffered())
		if high == 0 {
			if output.Available() == 0 {
				if err := output.Flush(); err != nil {
					return err
				}
			}
			used, decoded := decodeASCIISourceChunk(chunk, output.AvailableBuffer(), capture)
			if used != 0 {
				if _, err := output.Write(decoded); err != nil {
					return err
				}
				_, _ = input.Discard(used)
				continue
			}
		}
		plain := plainASCIISourceLength(chunk)
		if plain > 0 {
			if err := flushHigh(); err != nil {
				return err
			}
			capture.advancePlain(plain)
			if _, err := output.Write(chunk[:plain]); err != nil {
				return err
			}
			_, _ = input.Discard(plain)
			continue
		}
		b, err := input.ReadByte()
		if err != nil {
			return err
		}
		if b == '"' {
			return flushHigh()
		}
		if b < 0x20 {
			return errors.New("unescaped JSON string control character")
		}
		if b >= utf8.RuneSelf {
			_ = input.UnreadByte()
			r, _, err := input.ReadRune()
			if err != nil {
				return err
			}
			if err = emit(r); err != nil {
				return err
			}
			continue
		}
		if b != '\\' {
			return errors.New("invalid JSON string")
		}
		escape, err := input.ReadByte()
		if err != nil {
			return err
		}
		var r rune
		switch escape {
		case '"', '\\', '/':
			r = rune(escape)
		case 'b':
			r = '\b'
		case 'f':
			r = '\f'
		case 'n':
			r = '\n'
		case 'r':
			r = '\r'
		case 't':
			r = '\t'
		case 'u':
			var encoded [4]byte
			if _, err := io.ReadFull(input, encoded[:]); err != nil {
				return err
			}
			value, err := strconv.ParseUint(string(encoded[:]), 16, 16)
			if err != nil {
				return fmt.Errorf("invalid JSON Unicode escape: %w", err)
			}
			r = rune(value)
		default:
			return errors.New("invalid JSON escape")
		}
		if err := emit(r); err != nil {
			return err
		}
	}
}
