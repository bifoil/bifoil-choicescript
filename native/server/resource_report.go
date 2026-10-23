package main

import (
	"encoding/json"
	"os"
	"runtime"
	"runtime/debug"
)

// Optional development evidence is written outside the LSP channel. It measures
// the server high-water mark and simultaneous server/tool resident memory.
func writeResourceReport() {
	destination := os.Getenv("BIFOIL_NATIVE_RESOURCE_REPORT")
	if destination == "" {
		return
	}
	file, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		writeStderr("Could not save native resource evidence:", err)
		return
	}
	defer closeNativeFile(file)
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	combined := float64(combinedResidentPeak.Load()) / 1048576
	if combinedResidentUnavailable.Load() {
		combined = -1
	}
	hostAvailable := float64(-1)
	if hostMemoryMeasured.Load() {
		hostAvailable = float64(hostMinimumAvailable.Load()) / 1048576
	}
	err = json.NewEncoder(file).Encode(map[string]any{"serverAtCombinedPeakMiB": float64(serverAtCombinedPeak.Load()) / 1048576, "toolsAtCombinedPeakMiB": float64(toolsAtCombinedPeak.Load()) / 1048576, "hostMinimumAvailableMiB": hostAvailable, "hostSampleIntervalMs": 100, "runtimeProcessors": runtime.GOMAXPROCS(0), "goMemoryTargetMiB": debug.SetMemoryLimit(-1) / 1048576, "combinedPeakResidentMiB": combined, "sampleIntervalMs": 10, "peakResidentMiB": peakResidentMiB(), "liveMiB": float64(memory.HeapAlloc) / 1048576, "platform": runtime.GOOS + "-" + runtime.GOARCH})
	if err != nil {
		writeStderr("Could not write native resource evidence:", err)
	}
}
