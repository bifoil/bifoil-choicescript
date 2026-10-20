package core

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

type shortSourceReader struct {
	reader io.Reader
	size   int
}

func (r shortSourceReader) Read(p []byte) (int, error) { return r.reader.Read(p[:min(len(p), r.size)]) }

type brokenSourceReader struct{}

func (brokenSourceReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestStreamingParserMatchesAllFeaturesAcrossReadBoundaries(t *testing.T) {
	sources := []string{
		"", "\r", "\n", "\r\n", "\uFEFF*create gender \"male\"\r\n*create implicit_control_flow true\rShe said \"This is the end,\n*if gender = \"male\"\n    William.\"\n*else\n    Belle.\"\nShe walked away.",
		"*create score 1\n*gosub adjust\nYour [b]score[/b] is ${score}.\n*ending\n*label adjust\n*set score +1\n*return",
		"*temp value \"unfinished\r\nShe said \"Hello.\"\r*print 42\n",
		"*temp name \"N\"\n" + strings.Repeat("😀 [b]She[/b] said \"Hello ${name}.\" ", 3000) + "\r\n",
	}
	for _, text := range sources {
		for _, size := range []int{1, 3, 65536} {
			identity := Source{URI: "file:///original/scenes/startup.txt", Version: 7}
			input := identity
			input.Text = text
			full, err := ParseSourceContext(context.Background(), input)
			if err != nil {
				t.Fatal(err)
			}
			stream, err := ParseSourceReaderContext(context.Background(), identity, shortSourceReader{strings.NewReader(text), size})
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(full.document, stream.document) || !reflect.DeepEqual(full.names.Names, stream.names.Names) || !reflect.DeepEqual(full.values.entries, stream.values.entries) {
				t.Fatalf("different syntax with read size %d", size)
			}
			left, right := NewProject(), NewProject()
			left.AddParsed(full)
			right.AddParsed(stream)
			if err := left.Analyze(context.Background()); err != nil {
				t.Fatal(err)
			}
			if err := right.Analyze(context.Background()); err != nil {
				t.Fatal(err)
			}
			var a, b bytes.Buffer
			if err := left.WriteSnapshot(&a); err != nil {
				t.Fatal(err)
			}
			if err := right.WriteSnapshot(&b); err != nil {
				t.Fatal(err)
			}
			// Map order in metadata is not stable. Compare decoded query projects.
			l, err := ReadSnapshot(&a)
			if err != nil {
				t.Fatal(err)
			}
			r, err := ReadSnapshot(&b)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(l.Tokens, r.Tokens) || !reflect.DeepEqual(l.Documents, r.Documents) || !reflect.DeepEqual(l.Symbols, r.Symbols) {
				t.Fatalf("different complete query results with read size %d", size)
			}
		}
	}
}
func TestStreamingParserPropagatesReadFailureAndCancellation(t *testing.T) {
	parsed, err := ParseSourceReaderContext(context.Background(), Source{}, brokenSourceReader{})
	if parsed != nil || !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatal(parsed, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	parsed, err = ParseSourceReaderContext(ctx, Source{}, strings.NewReader("Original prose."))
	if parsed != nil || !errors.Is(err, context.Canceled) {
		t.Fatal(parsed, err)
	}
}

func TestProseSummaryPreservesReferenceWordCountsAndUTF16(t *testing.T) {
	alphabet := []rune("azAZ09_ '’[]b/\tΩ😀“”\"!?${}")
	state := uint64(37)
	for example := range 2000 {
		var text strings.Builder
		for n := 0; n < example%90; n++ {
			state = state*6364136223846793005 + 1
			text.WriteRune(alphabet[(state>>32)%uint64(len(alphabet))])
		}
		raw := text.String()
		document := new(Document)
		words, width := document.summarizeProse(raw, 0)
		if words != countWords(raw) || width != units(raw) {
			t.Fatalf("summary for %q: words %d/%d, width %d/%d", raw, words, countWords(raw), width, units(raw))
		}
	}
}

func TestASCIIWordRunsMatchScalarRulesAtEveryBoundary(t *testing.T) {
	state := uint64(97)
	for range 20000 {
		var data [8]byte
		for i := range data {
			state = state*6364136223846793005 + 1
			data[i] = byte(state>>32) & 127
		}
		for _, inside := range []bool{false, true} {
			starts, last, ok := asciiWordStarts(binary.LittleEndian.Uint64(data[:]), inside)
			if !ok {
				continue
			}
			prefix := ""
			if inside {
				prefix = "x"
			}
			expected := countWords(prefix+string(data[:])) - countWords(prefix)
			if starts != expected || last != wordCharacter(rune(data[7])) {
				t.Fatalf("ASCII boundary %q inside=%v: %d/%d", data, inside, starts, expected)
			}
		}
	}
}

func TestCompactLineStorageMatchesDenseSourceAndAllQueries(t *testing.T) {
	text := "*create score 1\n*create implicit_control_flow true\n*temp_array items 2 1 \"other\"\n" + strings.Repeat("She said \"Hello.\"\n\n", 700) + "*if score > 0\n  *gosub helper items[1]\n*else\n  Other.\n*print score\n*ending\n*label helper\n*params incoming\n*set score incoming\n*return\n"
	compact, dense := NewProject(), NewProject()
	compact.AddSource(Source{URI: "file:///original/startup.txt", Text: text})
	dense.AddSource(Source{URI: "file:///original/startup.txt", Text: text, denseRows: true})
	if compact.Documents[0].rowData == nil || dense.Documents[0].rowData != nil {
		t.Fatal("comparison did not exercise both storage forms")
	}
	var storage bytes.Buffer
	if err := ParseSource(Source{URI: "file:///original/startup.txt", Text: text}).WriteParsed(&storage); err != nil {
		t.Fatal(err)
	}
	restored, err := ReadParsed(&storage, Source{URI: "file:///original/startup.txt"})
	if err != nil {
		t.Fatal(err)
	}
	cached := NewProject()
	cached.AddParsed(restored)
	for _, p := range []*Project{compact, dense, cached} {
		if err := p.Analyze(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range []*Project{dense, cached} {
		if !reflect.DeepEqual(compact.Tokens, p.Tokens) || !reflect.DeepEqual(compact.Symbols, p.Symbols) || !reflect.DeepEqual(compact.Documents[0].Diagnostics, p.Documents[0].Diagnostics) || !reflect.DeepEqual(compact.Folding(0), p.Folding(0)) || compact.WordCount(0) != p.WordCount(0) {
			t.Fatal("physical-line compaction changed complete analysis")
		}
	}
	sourceTable := append([]queryRow(nil), compact.Documents[0].rowData.nodes...)
	var snapshot bytes.Buffer
	if err := compact.WriteSnapshot(&snapshot); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sourceTable, compact.Documents[0].rowData.nodes) {
		t.Fatal("non-consuming snapshot changed source storage")
	}
	expected := compact.EncodeTokens(0)
	compact.CompactForQueries()
	if compact.Documents[0].hasSourceRows() || !reflect.DeepEqual(expected, compact.EncodeTokens(0)) || !reflect.DeepEqual(compact.Folding(0), dense.Folding(0)) {
		t.Fatal("query compaction changed complete results")
	}
}

func TestContiguousASCIIProsePreservesUnicodeAndQuoteBoundaries(t *testing.T) {
	for _, suffix := range []string{"", "words", "'s finale.", "’s Ω😀", "[b]bracket[/b]", "\"Dialogue.\"", "“Curly.”"} {
		for offset := range 16 {
			text := strings.Repeat(" ", offset) + strings.Repeat("one two 3! four_five. ", 400) + suffix
			d := new(Document)
			words, width := d.summarizeProse(text, 0)
			if words != countWords(text) || width != units(text) {
				t.Fatal("ASCII run changed a scalar boundary")
			}
			if len(d.QuoteMarks) > 0 && d.QuoteMarks[0].First {
				t.Fatal("narrative quote incorrectly starts a paragraph")
			}
		}
	}
}
