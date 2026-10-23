package core

import (
	"bufio"
	"encoding/binary"
	"encoding/gob"
	"errors"
	"io"
	"io/fs"
)

// Metadata stays self-describing. Dense numeric pages use an explicit versioned
// encoding, avoiding reflection and a second whole-document temporary buffer.
type snapshotDocument struct {
	URI, Scene  string
	Version     int32
	Scope       uint32
	Diagnostics []Diagnostic
}
type snapshotOutput struct {
	writer *bufio.Writer
	buffer []byte
	err    error
}

func newSnapshotOutput(w io.Writer) *snapshotOutput {
	return &snapshotOutput{writer: bufio.NewWriterSize(w, 65536), buffer: make([]byte, 0, 65536)}
}
func (w *snapshotOutput) flush() {
	if w.err != nil {
		return
	}
	_, w.err = w.writer.Write(w.buffer)
	w.buffer = w.buffer[:0]
}
func (w *snapshotOutput) u(value uint64) {
	if w.err != nil {
		return
	}
	if len(w.buffer) > cap(w.buffer)-10 {
		w.flush()
	}
	w.buffer = binary.AppendUvarint(w.buffer, value)
}
func (w *snapshotOutput) bytes(data []byte) {
	w.u(uint64(len(data)))
	w.flush()
	if w.err == nil {
		_, w.err = w.writer.Write(data)
	}
}
func (w *snapshotOutput) uints(data []uint32) {
	w.u(uint64(len(data)))
	for _, value := range data {
		w.u(uint64(value))
	}
}
func (w *snapshotOutput) tokens(tokens []Token) {
	w.u(uint64(len(tokens)))
	for _, t := range tokens {
		w.u(uint64(t.Line))
		w.u(uint64(t.Start))
		w.u(uint64(t.Length))
		w.u(uint64(t.Symbol))
		w.u(uint64(t.ReferenceLength))
		w.u(uint64(t.Type))
		w.u(uint64(t.Modifiers))
	}
}
func (w *snapshotOutput) tokenSequence(tokens TokenSequence) {
	w.u(uint64(tokens.Len()))
	for _, t := range tokens.All() {
		w.u(uint64(t.Line))
		w.u(uint64(t.Start))
		w.u(uint64(t.Length))
		w.u(uint64(t.Symbol))
		w.u(uint64(t.ReferenceLength))
		w.u(uint64(t.Type))
		w.u(uint64(t.Modifiers))
	}
}
func (p *Project) writeNumericSnapshot(destination io.Writer, metadata QuerySnapshot) error {
	output := newSnapshotOutput(destination)
	encoder := gob.NewEncoder(output.writer)
	if err := encoder.Encode(uint32(7)); err != nil {
		return err
	}
	if err := encoder.Encode(metadata); err != nil {
		return err
	}
	output.u(uint64(len(p.Documents)))
	for index, original := range p.Documents {
		d := original
		if d.hasSourceRows() {
			cloned := *d
			cloned.cloneQueryLineTable()
			cloned.compactQueryRows()
			d = &cloned
		}
		output.flush()
		if output.err != nil {
			return output.err
		}
		if err := encoder.Encode(snapshotDocument{d.URI, d.Scene, d.Version, d.Scope, d.Diagnostics}); err != nil {
			return err
		}
		output.u(uint64(len(d.QueryRows)))
		for _, r := range d.QueryRows {
			output.u(uint64(r.Parent))
			output.u(uint64(r.Command))
			output.u(uint64(r.Indent))
			output.u(uint64(r.Body))
			output.u(uint64(r.SyntaxStart))
			output.u(uint64(r.Kind))
			output.u(uint64(r.Flags))
		}
		output.tokens(d.Syntax)
		output.metrics(d.Widths, d.widthMetrics)
		output.metrics(d.WordCounts, d.wordMetrics)
		output.bytes(d.ProseEntries)
		output.u(uint64(len(d.ProseEffects)))
		for _, effect := range d.ProseEffects {
			output.u(effect)
		}
		output.tokenSequence(p.TokenSequence(uint32(index)))
	}
	output.flush()
	if output.err != nil {
		return output.err
	}
	return output.writer.Flush()
}

type snapshotInput struct {
	reader          *bufio.Reader
	consumed, total uint64
	known           bool
	err             error
}

func newSnapshotInput(r io.Reader) *snapshotInput {
	input := &snapshotInput{reader: bufio.NewReaderSize(r, 65536)}
	if sized, ok := r.(interface{ Len() int }); ok {
		input.total = uint64(sized.Len())
		input.known = true
	} else if sized, ok := r.(interface{ Size() int64 }); ok && sized.Size() >= 0 {
		input.total = uint64(sized.Size())
		input.known = true
	} else if statter, ok := r.(interface{ Stat() (fs.FileInfo, error) }); ok {
		if info, err := statter.Stat(); err == nil && info.Size() >= 0 {
			input.total = uint64(info.Size())
			input.known = true
			if seeker, ok := r.(io.Seeker); ok {
				if offset, err := seeker.Seek(0, io.SeekCurrent); err == nil && offset >= 0 && uint64(offset) <= input.total {
					input.total -= uint64(offset)
				}
			}
		}
	}
	return input
}
func (r *snapshotInput) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	r.consumed += uint64(n)
	return n, err
}
func (r *snapshotInput) ReadByte() (byte, error) {
	value, err := r.reader.ReadByte()
	if err == nil {
		r.consumed++
	}
	return value, err
}
func (r *snapshotInput) u() uint64 {
	if r.err != nil {
		return 0
	}
	value, err := binary.ReadUvarint(r)
	r.err = err
	return value
}
func (r *snapshotInput) u32() uint32 {
	value := r.u()
	if value > uint64(^uint32(0)) {
		r.err = errors.New("query index integer overflow")
		return 0
	}
	return uint32(value)
}
func (r *snapshotInput) u8() uint8 {
	value := r.u()
	if value > 255 {
		r.err = errors.New("query index byte overflow")
		return 0
	}
	return uint8(value)
}
func (r *snapshotInput) count(minimum uint64) int {
	count := r.u()
	if r.err != nil {
		return 0
	}
	if count > uint64(^uint32(0)) || r.known && (r.consumed > r.total || count > (r.total-r.consumed)/minimum) {
		r.err = errors.New("invalid query index page length")
		return 0
	}
	return int(count)
}
func (r *snapshotInput) bytes() []byte {
	count := r.count(1)
	if count == 0 {
		return nil
	}
	data := make([]byte, count)
	if r.err == nil {
		_, r.err = io.ReadFull(r, data)
	}
	return data
}
func (r *snapshotInput) uints() []uint32 {
	count := r.count(1)
	if count == 0 {
		return nil
	}
	data := make([]uint32, count)
	for index := range data {
		data[index] = r.u32()
	}
	return data
}
func (r *snapshotInput) tokens() []Token {
	count := r.count(7)
	if count == 0 {
		return nil
	}
	data := make([]Token, count)
	for i := range data {
		data[i] = Token{Line: r.u32(), Start: r.u32(), Length: r.u32(), Symbol: r.u32(), ReferenceLength: r.u32(), Type: r.u8(), Modifiers: r.u8()}
	}
	return data
}
func readNumericSnapshot(source io.Reader) (*Project, error) {
	input := newSnapshotInput(source)
	decoder := gob.NewDecoder(input)
	var version uint32
	var metadata QuerySnapshot
	if err := decoder.Decode(&version); err != nil {
		return nil, err
	}
	if version != 7 {
		return nil, errors.New("unsupported query snapshot version")
	}
	if err := decoder.Decode(&metadata); err != nil {
		return nil, err
	}
	count := input.count(1)
	for range count {
		var header snapshotDocument
		if err := decoder.Decode(&header); err != nil {
			return nil, err
		}
		d := &Document{URI: header.URI, Scene: header.Scene, Version: header.Version, Scope: header.Scope, Diagnostics: header.Diagnostics}
		rows := input.count(7)
		d.QueryRows = make([]queryRow, rows)
		for i := range d.QueryRows {
			d.QueryRows[i] = queryRow{Parent: input.u32(), Command: input.u32(), Indent: input.u32(), Body: input.u32(), SyntaxStart: input.u32(), Kind: input.u8(), Flags: input.u8()}
		}
		d.Syntax = input.tokens()
		d.Widths, d.widthMetrics = input.metrics()
		d.WordCounts, d.wordMetrics = input.metrics()
		d.ProseEntries = input.bytes()
		effects := input.count(1)
		d.ProseEffects = make([]uint64, effects)
		for i := range d.ProseEffects {
			d.ProseEffects[i] = input.u()
		}
		tokens := input.tokens()
		if input.err != nil {
			return nil, input.err
		}
		if len(d.QueryRows) != d.widthCount()+1 || d.wordCountLen() != d.widthCount() || len(d.ProseEntries) != d.widthCount() || len(d.ProseEffects) != 0 && len(d.ProseEffects) != d.widthCount() {
			return nil, errors.New("inconsistent query row counts")
		}
		metadata.Documents = append(metadata.Documents, d)
		metadata.Tokens = append(metadata.Tokens, tokens)
	}
	if input.err != nil {
		return nil, input.err
	}
	p := &Project{literalDeclarations: metadata.LiteralDeclarations, unsafeRenames: metadata.UnsafeRenames, Documents: metadata.Documents, Tokens: metadata.Tokens, Symbols: metadata.Symbols, SymbolValues: metadata.SymbolValues, SceneSymbols: metadata.SceneSymbols, names: registry{Names: metadata.Names}, arraySymbols: metadata.ArraySymbols, parameterScenes: metadata.ParameterScenes, Steps: metadata.Steps, QuoteWarnings: metadata.QuoteWarnings, Revision: metadata.Revision}
	p.compactQueryTokens()
	return p, nil
}
