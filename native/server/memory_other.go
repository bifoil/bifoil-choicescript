//go:build !darwin && !linux && !windows

package main

// Unsupported measurements are unavailable, never reported as zero memory.
func peakResidentMiB() float64 { return -1 }

func currentResidentBytes() int64            { return -1 }
func (p *ownedProcess) residentBytes() int64 { return -1 }
