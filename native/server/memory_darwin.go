package main

import (
	"encoding/binary"
	"errors"
	"math"
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

// Darwin's proc_info ABI is shared by amd64 and arm64. Use the kernel interface
// behind libproc without CGO, helper processes, or retained process snapshots.
// ABI reference: apple-oss-distributions/xnu, bsd/sys/proc_info{,_private}.h.
const (
	darwinListPIDs     = 1
	darwinPIDInfo      = 2
	darwinProcessGroup = 2
	darwinTaskInfo     = 4
	darwinTaskInfoSize = 96
)

func peakResidentMiB() float64 {
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil || usage.Maxrss <= 0 {
		return -1
	}
	// Unlike Linux, Darwin reports ru_maxrss in bytes.
	return float64(usage.Maxrss) / 1048576
}

func darwinResidentBytes(pid int) int64 {
	if pid <= 0 {
		return -1
	}
	var info [darwinTaskInfoSize]byte
	read, _, err := syscall.Syscall6(syscall.SYS_PROC_INFO, darwinPIDInfo, uintptr(pid), darwinTaskInfo, 0, uintptr(unsafe.Pointer(&info[0])), uintptr(len(info)))
	runtime.KeepAlive(&info)
	if errors.Is(err, syscall.ESRCH) {
		return 0 // An owned process may exit between enumeration and sampling.
	}
	if err != 0 || read != uintptr(len(info)) {
		return -1
	}
	resident := binary.LittleEndian.Uint64(info[8:16])
	if resident > math.MaxInt64 {
		return -1
	}
	return int64(resident)
}

func currentResidentBytes() int64 { return darwinResidentBytes(os.Getpid()) }

func (p *ownedProcess) residentBytes() int64 {
	if p.pid <= 0 {
		return -1
	}
	// Count the owned process group, including descendants reparented after the
	// broker exits. Never accept a full buffer as a complete process inventory.
	for capacity := 128; capacity <= 1<<18; capacity *= 2 {
		pids := make([]int32, capacity)
		length := uintptr(len(pids)) * unsafe.Sizeof(pids[0])
		read, _, err := syscall.Syscall6(syscall.SYS_PROC_INFO, darwinListPIDs, darwinProcessGroup, uintptr(p.pid), 0, uintptr(unsafe.Pointer(&pids[0])), length)
		runtime.KeepAlive(pids)
		if err != 0 || read > length || read%4 != 0 {
			return -1
		}
		if read == length {
			continue
		}
		var total int64
		for _, pid := range pids[:read/4] {
			if pid <= 0 {
				continue
			}
			resident := darwinResidentBytes(int(pid))
			if resident < 0 || resident > math.MaxInt64-total {
				return -1
			}
			total += resident
		}
		return total
	}
	return -1
}
