package main

import (
	"fmt"
	"os"
)

// closeRuntime completes ownership cleanup before the shutdown response. Editors
// may terminate the child immediately after that response instead of waiting for
// exit-time defers; leaving capture disposal until exit leaks large source files.
// The transport stays open for the shutdown acknowledgement and subsequent exit.
func (s *nativeServer) closeRuntime() error {
	s.runtimeClose.Do(func() {
		s.mu.Lock()
		s.shutdown = true
		if s.activeCancel != nil {
			s.activeCancel()
		}
		for _, request := range s.requests {
			request.cancel()
		}
		for _, pending := range s.toolStarts {
			pending.Cancel()
		}
		s.signalLocked()
		s.mu.Unlock()
		if s.cancel != nil {
			s.cancel()
		}
		if s.tools != nil {
			s.tools.close()
		}
		s.worker.Wait()
		s.handlers.Wait()
		if s.parseCache != nil {
			s.parseCache.close()
		}
		if s.stream != nil && s.stream.captures != nil {
			s.stream.captures.close()
		}
		if s.cacheDir != "" {
			if err := os.RemoveAll(s.cacheDir); err != nil {
				s.runtimeCloseErr = fmt.Errorf("could not remove the owned language cache: %w", err)
			}
		}
		if s.stopResources != nil {
			s.stopResources()
		}
		if s.saveResourceReport != nil {
			s.saveResourceReport()
		}
	})
	return s.runtimeCloseErr
}
