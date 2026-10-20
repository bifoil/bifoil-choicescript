package main

import (
	"os"
	"path/filepath"
	"strings"
)

// URI-local protocol versions cannot order edits in two aliases. Transport order
// chooses the latest complete buffer; a URI tie-break keeps imported maps
// deterministic without conflating distinct case-sensitive physical files.
func latestNativeBuffer(file string, buffers map[string]openBuffer) (openBuffer, bool) {
	var selected openBuffer
	found := false
	var physical os.FileInfo
	for uri, buffer := range buffers {
		candidate, err := uriPath(uri)
		if err != nil {
			continue
		}
		same := filepath.Clean(candidate) == filepath.Clean(file)
		if !same && strings.EqualFold(filepath.Base(candidate), filepath.Base(file)) {
			if physical == nil {
				physical, _ = os.Stat(file)
			}
			info, err := os.Stat(candidate)
			same = physical != nil && err == nil && os.SameFile(physical, info)
		}
		if same && (!found || buffer.Order > selected.Order || buffer.Order == selected.Order && uri < selected.URI) {
			selected = buffer
			selected.URI = uri
			found = true
		}
	}
	return selected, found
}
