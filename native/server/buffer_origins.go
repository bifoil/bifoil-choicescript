package main

import (
	"maps"
	"os"
	"path/filepath"
	"strings"
)

// Origins retain identity/version only, never a buffer's backing file or line
// offsets. A disk-equality check cannot validate a snapshot built from unsaved
// text, even when that text had protocol version zero.
func bufferVersions(buffers map[string]openBuffer) map[string]int32 {
	if len(buffers) == 0 {
		return nil
	}
	result := make(map[string]int32, len(buffers))
	for uri, buffer := range buffers {
		result[uri] = buffer.Version
	}
	return result
}
func cloneBufferVersions(original map[string]int32) map[string]int32 {
	result := make(map[string]int32, len(original)+1)
	maps.Copy(result, original)
	return result
}
func hasBufferOrigin(origins map[string]int32, uri string) bool {
	if _, found := origins[uri]; found {
		return true
	}
	file, err := uriPath(uri)
	if err != nil {
		return false
	}
	var info os.FileInfo
	for other := range origins {
		candidate, e := uriPath(other)
		if e != nil {
			continue
		}
		if filepath.Clean(candidate) == filepath.Clean(file) {
			return true
		}
		if !strings.EqualFold(filepath.Base(candidate), filepath.Base(file)) {
			continue
		}
		if info == nil {
			info, err = os.Stat(file)
			if err != nil {
				return false
			}
		}
		previous, e := os.Stat(candidate)
		if e == nil && os.SameFile(info, previous) {
			return true
		}
	}
	return false
}
