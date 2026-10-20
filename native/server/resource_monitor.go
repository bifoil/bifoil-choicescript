package main

import (
	"os"
	"sync"
	"sync/atomic"
	"time"
)

var serverAtCombinedPeak atomic.Int64
var toolsAtCombinedPeak atomic.Int64
var combinedResidentPeak atomic.Int64
var combinedResidentUnavailable atomic.Bool
var hostMinimumAvailable atomic.Int64
var hostMemoryMeasured atomic.Bool

// Development evidence samples simultaneous resident memory, including every
// broker/tool descendant owned by the Windows job or Linux process tree. It is
// enabled explicitly with the report destination and never writes on LSP stdout.
func monitorOwnedResources(s *nativeServer) func() {
	if os.Getenv("BIFOIL_NATIVE_RESOURCE_REPORT") == "" {
		return func() {}
	}
	stop := make(chan struct{})
	var stopOnce sync.Once
	var worker sync.WaitGroup
	worker.Go(func() {
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		tick := 0
		for {
			if tick%10 == 0 {
				if available := availableHostMemoryBytes(); available >= 0 {
					if !hostMemoryMeasured.Load() || available < hostMinimumAvailable.Load() {
						hostMinimumAvailable.Store(available)
					}
					hostMemoryMeasured.Store(true)
				}
			}
			tick++
			serverBytes := currentResidentBytes()
			bytes := serverBytes
			s.tools.mu.Lock()
			process := s.tools.process
			s.tools.mu.Unlock()
			if process != nil {
				children := process.owner.residentBytes()
				if children < 0 {
					bytes = -1
				} else if bytes >= 0 {
					bytes += children
				}
			}
			if bytes < 0 {
				combinedResidentUnavailable.Store(true)
			} else {
				for old := combinedResidentPeak.Load(); bytes > old; old = combinedResidentPeak.Load() {
					if combinedResidentPeak.CompareAndSwap(old, bytes) {
						serverAtCombinedPeak.Store(serverBytes)
						toolsAtCombinedPeak.Store(bytes - serverBytes)
						break
					}
				}
			}
			select {
			case <-stop:
				return
			case <-ticker.C:
			}
		}
	})
	return func() {
		stopOnce.Do(func() { close(stop) })
		worker.Wait()
	}
}
