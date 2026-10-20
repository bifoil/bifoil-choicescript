package main

import (
	"fmt"
	"io"
	"sort"
)

const openTextBudget = 4 * 1024 * 1024

// Small LSP frames normally remain strings. Bound their aggregate retention too:
// opening many individually small scenes must not retain the whole game's prose
// in memory. Only fresh, owned temporary captures are eligible for cleanup.
func (s *nativeServer) boundOpenBuffersLocked() error {
	type candidate struct {
		uri   string
		bytes int
	}
	var total int64
	var candidates []candidate
	for uri, buffer := range s.buffers {
		if buffer.Store == nil && len(buffer.Text) > 0 {
			total += int64(len(buffer.Text))
			candidates = append(candidates, candidate{uri, len(buffer.Text)})
		}
	}
	if total <= openTextBudget {
		return nil
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].bytes == candidates[j].bytes {
			return candidates[i].uri < candidates[j].uri
		}
		return candidates[i].bytes > candidates[j].bytes
	})
	for _, candidate := range candidates {
		buffer := s.buffers[candidate.uri]
		capture, err := newSourceCapture(s.stream.textDirectory, s.stream.captures)
		if err != nil {
			return fmt.Errorf("could not back open sources with private temporary storage: %w", err)
		}
		store, err := func() (*textStore, error) {
			defer capture.abort()
			if _, err := io.WriteString(capture, buffer.Text); err != nil {
				return nil, err
			}
			return capture.finish()
		}()
		if err != nil {
			return fmt.Errorf("could not preserve an open source in private temporary storage: %w", err)
		}
		buffer.Store, buffer.Text = store, ""
		s.buffers[candidate.uri] = buffer
		total -= int64(candidate.bytes)
		if total <= openTextBudget {
			break
		}
	}
	return nil
}
