package main

import (
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestResourceMonitorStopIsConcurrentAndIdempotent(t *testing.T) {
	t.Setenv("BIFOIL_NATIVE_RESOURCE_REPORT", filepath.Join(t.TempDir(), "report.json"))
	server := &nativeServer{}
	server.tools = &toolBridge{server: server}
	stop := monitorOwnedResources(server)
	defer stop()
	done := make(chan struct{})
	go func() {
		var callers sync.WaitGroup
		for range 4 {
			callers.Go(stop)
		}
		callers.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("resource monitor failed to stop")
	}
}
