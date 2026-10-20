package main

import (
	"syscall"
	"unsafe"
)

var memoryKernel = syscall.NewLazyDLL("kernel32.dll")
var queryMemory = memoryKernel.NewProc("K32GetProcessMemoryInfo")
var queryCurrentProcess = memoryKernel.NewProc("GetCurrentProcess")
var queryJobProcesses = memoryKernel.NewProc("QueryInformationJobObject")

// Windows records the process working-set high-water mark independently of the
// Go heap. Tool acceptance additionally samples and sums all owned descendants.
func peakResidentMiB() float64 {
	type counters struct {
		Size, Faults                                                                                          uint32
		PeakWorkingSet, WorkingSet, PeakPaged, Paged, PeakNonPaged, NonPaged, Pagefile, PeakPagefile, Private uintptr
	}
	var data counters
	data.Size = uint32(unsafe.Sizeof(data))
	handle, _, _ := queryCurrentProcess.Call()
	ok, _, _ := queryMemory.Call(handle, uintptr(unsafe.Pointer(&data)), uintptr(data.Size))
	if ok == 0 {
		return -1
	}
	return float64(data.PeakWorkingSet) / 1048576
}

func windowsResidentBytes(handle uintptr) int64 {
	type counters struct {
		Size, Faults                                                                                          uint32
		PeakWorkingSet, WorkingSet, PeakPaged, Paged, PeakNonPaged, NonPaged, Pagefile, PeakPagefile, Private uintptr
	}
	var data counters
	data.Size = uint32(unsafe.Sizeof(data))
	ok, _, _ := queryMemory.Call(handle, uintptr(unsafe.Pointer(&data)), uintptr(data.Size))
	if ok == 0 {
		return -1
	}
	return int64(data.WorkingSet)
}
func currentResidentBytes() int64 { return windowsResidentBytes(^uintptr(0)) }
func (p *ownedProcess) residentBytes() int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return 0
	}
	var list struct {
		Assigned, Count uint32
		PIDs            [128]uintptr
	}
	ok, _, _ := queryJobProcesses.Call(uintptr(p.handle), 3, uintptr(unsafe.Pointer(&list)), unsafe.Sizeof(list), 0)
	if ok == 0 || list.Count > uint32(len(list.PIDs)) {
		return -1
	}
	var total int64
	for _, pid := range list.PIDs[:list.Count] {
		handle, err := syscall.OpenProcess(0x1000|0x10, false, uint32(pid))
		if err != nil {
			if err == syscall.Errno(87) || err == syscall.Errno(1168) {
				continue
			}
			return -1
		}
		bytes := windowsResidentBytes(uintptr(handle))
		_ = syscall.CloseHandle(handle)
		if bytes < 0 {
			return -1
		}
		total += bytes
	}
	return total
}
