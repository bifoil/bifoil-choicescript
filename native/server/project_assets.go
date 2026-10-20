package main

import (
	"context"
	"path/filepath"
	"strings"
	"time"
)

// Match snapshot-owned assets without allowing the plugin's own logs, builds,
// hidden folders or export output to make every completed run stale again.
func nativeAssetAffects(project gameProject, file string) bool {
	if !inside(project.AssetDir, file) {
		return false
	}
	relative, _ := filepath.Rel(project.AssetDir, file)
	for part := range strings.SplitSeq(relative, string(filepath.Separator)) {
		if strings.HasPrefix(part, ".") {
			return false
		}
		switch part {
		case "node_modules", "vendor", "dist", "build", "export":
			return false
		}
	}
	return true
}

// Removing a project cancels its registered previews/runs through the existing
// broker. Do not start a broker merely because an unused project disappeared.
func (s *nativeServer) stopRemovedTools(id string) {
	if s.tools == nil {
		return
	}
	s.tools.mu.Lock()
	process := s.tools.process
	s.tools.mu.Unlock()
	if process == nil {
		return
	}
	s.handlers.Go(func() {
		ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
		defer cancel()
		_, _ = process.call(ctx, "job", map[string]any{"request": toolRequest{ProtocolVersion: 1, Operation: "stop", ProjectID: id}})
	})
}
