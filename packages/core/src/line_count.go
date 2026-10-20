package core

import (
	"bytes"
	"context"
	"io"
)

// CountSourceLines makes a bounded-memory sizing pass and restores the reader's
// position. Exact sizing avoids repeatedly growing large numeric line arenas;
// the count changes allocation only, never which source lines are analyzed.
func CountSourceLines(ctx context.Context, source io.ReadSeeker) (count int, err error) {
	start, err := source.Seek(0, io.SeekCurrent)
	if err != nil {
		return 0, err
	}
	defer func() {
		_, restore := source.Seek(start, io.SeekStart)
		if err == nil {
			err = restore
		}
	}()
	if err = ctx.Err(); err != nil {
		return 0, err
	}
	if sized, ok := source.(interface{ PhysicalLineCount() int }); start == 0 && ok && sized.PhysicalLineCount() > 0 {
		return sized.PhysicalLineCount(), nil
	}
	// Larger reads avoid hundreds of synchronous filesystem calls for a giant
	// scene. Sizing remains bounded, cancellation is checked between each read.
	buffer := make([]byte, 1024*1024)
	count = 1
	previousCR := false
	for {
		if err = ctx.Err(); err != nil {
			return 0, err
		}
		n, readErr := source.Read(buffer)
		if n > 0 {
			data := buffer[:n]
			count += bytes.Count(data, []byte{'\r'}) + bytes.Count(data, []byte{'\n'}) - bytes.Count(data, []byte{'\r', '\n'})
			if previousCR && data[0] == '\n' {
				count--
			}
			previousCR = data[n-1] == '\r'
		}
		if readErr == io.EOF {
			return count, nil
		}
		if readErr != nil {
			return 0, readErr
		}
		if n == 0 {
			return 0, io.ErrNoProgress
		}
	}
}
