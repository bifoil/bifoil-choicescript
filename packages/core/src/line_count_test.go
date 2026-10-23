package core

import (
	"bytes"
	"context"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

type shortReadSeeker struct {
	io.ReadSeeker
	size int
}

func (s shortReadSeeker) Read(p []byte) (int, error) {
	return s.ReadSeeker.Read(p[:min(len(p), s.size)])
}

func TestLineSizingPreservesBoundariesPositionAndCompleteParse(t *testing.T) {
	for _, text := range []string{"", "\r", "\n", "\r\n", "\r\n\r\n", strings.Repeat(" ", 65535) + "\r\n*temp value 1\rOriginal prose.\n", "*temp value \"name\"\r\nShe said \"Hello.\"\r\n\t\u2003\n\"Continued.\""} {
		for _, size := range []int{1, 3, 65536} {
			reader := shortReadSeeker{strings.NewReader("ignored" + text), size}
			if _, err := reader.Seek(7, io.SeekStart); err != nil {
				t.Fatal(err)
			}
			count, err := CountSourceLines(context.Background(), reader)
			if err != nil {
				t.Fatal(err)
			}
			expected := 1 + strings.Count(text, "\r") + strings.Count(text, "\n") - strings.Count(text, "\r\n")
			position, _ := reader.Seek(0, io.SeekCurrent)
			if count != expected || position != 7 {
				t.Fatalf("count=%d/%d position=%d", count, expected, position)
			}
			identity := Source{URI: "file:///original/startup.txt"}
			sized, err := ParseSourceReaderContext(context.Background(), identity, reader, count)
			if err != nil {
				t.Fatal(err)
			}
			full, err := ParseSourceReaderContext(context.Background(), identity, strings.NewReader(text))
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(sized.document, full.document) {
				t.Fatal("sizing changed complete syntax")
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	reader := bytes.NewReader([]byte("original"))
	_, _ = reader.Seek(2, io.SeekStart)
	if _, err := CountSourceLines(ctx, reader); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if position, _ := reader.Seek(0, io.SeekCurrent); position != 2 {
		t.Fatal(position)
	}
}
