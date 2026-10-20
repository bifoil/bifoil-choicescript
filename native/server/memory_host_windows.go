package main

import "unsafe"

var queryHostMemory = memoryKernel.NewProc("GlobalMemoryStatusEx")

// Host pressure is separate diagnostic evidence, never part of (or a substitute
// for) the measured plugin-owned resident-memory budget.
func availableHostMemoryBytes() int64 {
	var status struct {
		Length, Load                                                                                                                 uint32
		TotalPhysical, AvailablePhysical, TotalPagefile, AvailablePagefile, TotalVirtual, AvailableVirtual, AvailableExtendedVirtual uint64
	}
	status.Length = uint32(unsafe.Sizeof(status))
	ok, _, _ := queryHostMemory.Call(uintptr(unsafe.Pointer(&status)))
	if ok == 0 {
		return -1
	}
	return int64(status.AvailablePhysical)
}
