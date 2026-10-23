package main

import (
	"fmt"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"
)

// A Windows job owns the broker and every official tool descendant. Closing the
// handle kills survivors even if the pipe or broker fails before cleanup.
type ownedProcess struct {
	handle syscall.Handle
	mu     sync.Mutex
}

func configureOwnedProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
func ownProcess(command *exec.Cmd) (*ownedProcess, error) {
	kernel := syscall.NewLazyDLL("kernel32.dll")
	job, _, err := kernel.NewProc("CreateJobObjectW").Call(0, 0)
	if job == 0 {
		return nil, fmt.Errorf("create tool job: %w", err)
	}
	owner := &ownedProcess{handle: syscall.Handle(job)}
	type basicLimits struct {
		perProcess, perJob   int64
		flags                uint32
		minimum, maximum     uintptr
		active               uint32
		affinity             uintptr
		priority, scheduling uint32
	}
	type ioCounters struct{ read, write, other, readBytes, writeBytes, otherBytes uint64 }
	type extendedLimits struct {
		basic                                          basicLimits
		io                                             ioCounters
		processMemory, jobMemory, peakProcess, peakJob uintptr
	}
	limits := extendedLimits{}
	limits.basic.flags = 0x2000
	ok, _, err := kernel.NewProc("SetInformationJobObject").Call(job, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		_ = owner.Close()
		return nil, fmt.Errorf("configure tool job: %w", err)
	}
	process, err := syscall.OpenProcess(0x0100|0x0001, false, uint32(command.Process.Pid))
	if err != nil {
		_ = owner.Close()
		return nil, err
	}
	defer func() { _ = syscall.CloseHandle(process) }()
	ok, _, err = kernel.NewProc("AssignProcessToJobObject").Call(job, uintptr(process))
	if ok == 0 {
		_ = owner.Close()
		return nil, fmt.Errorf("own tool process: %w", err)
	}
	return owner, nil
}
func (p *ownedProcess) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return nil
	}
	err := syscall.CloseHandle(p.handle)
	p.handle = 0
	return err
}
