package main

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestBatchSourceDecodingPreservesEveryEscapeAcrossReadAndWriteBoundaries(t *testing.T) {
	encodings := []string{
		`"` + strings.Repeat(`plain words\n\r\n\t\b\f\\\/\"`, 3000) + `tail"`,
		`"` + strings.Repeat(`ASCII \ud83d\ude00 Ω😀 \ud800x \udc00 \ud800\ud800\udfff\r\n`, 1000) + `"`,
	}
	for _, encoded := range encodings {
		var expected string
		if err := json.Unmarshal([]byte(encoded), &expected); err != nil {
			t.Fatal(err)
		}
		for _, size := range []int{16, 31, 65536} {
			capture, err := newSourceCapture(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			input := bufio.NewReaderSize(strings.NewReader(encoded[1:]), size)
			output := bufio.NewWriterSize(capture, size)
			if err = decodeSourceString(input, output, capture); err != nil {
				capture.abort()
				t.Fatal(err)
			}
			if err = output.Flush(); err != nil {
				capture.abort()
				t.Fatal(err)
			}
			store, err := capture.finish()
			if err != nil {
				capture.abort()
				t.Fatal(err)
			}
			actual, err := io.ReadAll(store.reader())
			if err != nil || string(actual) != expected {
				t.Fatal("batch decoder changed source bytes", err)
			}
			offsets, err := physicalLineOffsets(strings.NewReader(expected))
			if err != nil {
				t.Fatal(err)
			}
			if len(offsets) != len(store.lines) {
				t.Fatal("batch decoder changed physical line count")
			}
			for i, offset := range offsets {
				if offset != store.lines[i] {
					t.Fatal("batch decoder changed source offset")
				}
			}
			capture.owner.release(capture.file)
		}
	}
}
