package main

import (
	"bytes"
	"errors"
	"io"
	"math/rand/v2"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

func captureTestBuffer(t *testing.T, text string) openBuffer {
	t.Helper()
	directory := t.TempDir()
	owner := &captureOwner{files: make(map[*os.File]struct{})}
	t.Cleanup(owner.close)
	capture, err := newSourceCapture(directory, owner)
	if err != nil {
		t.Fatal(err)
	}
	defer capture.abort()
	if _, err = io.WriteString(capture, text); err != nil {
		t.Fatal(err)
	}
	store, err := capture.finish()
	if err != nil {
		t.Fatal(err)
	}
	return openBuffer{URI: "file:///original/startup.txt", Store: store, Version: 1}
}
func bufferContents(t *testing.T, buffer openBuffer) string {
	t.Helper()
	data, err := io.ReadAll(bufferReader(buffer))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
func TestFileBackedEditsMatchStringBuffers(t *testing.T) {
	const original = "😀 first\r\nsecond line\rthird\nfourth\r\n"
	file := captureTestBuffer(t, original)
	plain := openBuffer{Text: original, Version: 1}
	random := rand.New(rand.NewPCG(31, 79))
	inserts := []string{"", "Ω", "😀", "\n", "\r", "\r\n", "word", "\n\r"}
	for version := int32(2); version < 500; version++ {
		lines, err := physicalLineOffsets(strings.NewReader(plain.Text))
		if err != nil {
			t.Fatal(err)
		}
		line := random.IntN(len(lines))
		raw, _ := bufferLine(plain.Text, uint32(line))
		var positions []uint32
		var column uint32
		positions = append(positions, column)
		for _, r := range raw {
			column++
			if r > 0xffff {
				column++
			}
			positions = append(positions, column)
		}
		a, b := random.IntN(len(positions)), random.IntN(len(positions))
		if a > b {
			a, b = b, a
		}
		r := core.Range{Start: core.Position{Line: uint32(line), Character: positions[a]}, End: core.Position{Line: uint32(line), Character: positions[b]}}
		changes := []textChange{{Range: &r, Text: inserts[random.IntN(len(inserts))]}}
		oldFile := file
		oldText := plain.Text
		file, err = changeBuffer(file, version, changes)
		if err != nil {
			t.Fatal(err)
		}
		plain, err = changeBuffer(plain, version, changes)
		if err != nil {
			t.Fatal(err)
		}
		if got := bufferContents(t, file); got != plain.Text {
			t.Fatalf("version %d: %q != %q", version, got, plain.Text)
		}
		expected, err := physicalLineOffsets(strings.NewReader(plain.Text))
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(file.Store.lines, expected) {
			t.Fatalf("line index at version %d: %v != %v", version, file.Store.lines, expected)
		}
		if bufferContents(t, oldFile) != oldText {
			t.Fatal("an edit mutated a captured previous generation")
		}
	}
}
func TestCaptureAbortPreservesOriginalSources(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "startup.txt")
	original := []byte("Original source bytes.\r\n")
	if err := os.WriteFile(source, original, 0600); err != nil {
		t.Fatal(err)
	}
	capture, err := newSourceCapture(dir)
	if err != nil {
		t.Fatal(err)
	}
	name := capture.file.Name()
	_, _ = capture.file.WriteString("Incomplete transfer")
	capture.abort()
	if _, err = os.Stat(name); !os.IsNotExist(err) {
		t.Fatal("aborted capture remains", err)
	}
	actual, err := os.ReadFile(source)
	if err != nil || !bytes.Equal(actual, original) {
		t.Fatal("source changed", err)
	}
}

func TestOwnedSourceReadersPreservePhysicalLinesAndReadErrors(t *testing.T) {
	const original = "First Ω\r\nSecond 😀\rLast\n"
	buffer := captureTestBuffer(t, original)
	reader := buffer.Store.reader()
	if reader.PhysicalLineCount() != 4 {
		t.Fatal("CRLF, CR, or EOF changed the physical line count")
	}
	if n, err := buffer.Store.ReadAt(nil, 0); n != 0 || err != nil {
		t.Fatal("an empty read was not harmless", n, err)
	}
	if _, err := buffer.Store.ReadAt(make([]byte, 1), -1); err == nil {
		t.Fatal("a negative capture offset was accepted")
	}
	output := make([]byte, len(original)+5)
	n, err := buffer.Store.ReadAt(output, 0)
	if n != len(original) || !errors.Is(err, io.EOF) || string(output[:n]) != original {
		t.Fatal("a short capture read changed bytes or hid EOF", n, err)
	}
	if err := buffer.Store.pieces[0].backing.file.Close(); err != nil {
		t.Fatal(err)
	}
	if n, err = reader.Read(make([]byte, 1)); n != 0 || !errors.Is(err, os.ErrClosed) {
		t.Fatal("an unavailable capture did not retain its read error", n, err)
	}
}
