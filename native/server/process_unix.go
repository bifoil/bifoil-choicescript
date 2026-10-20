//go:build !windows

package main

import (
	"os/exec"
	"sync"
	"syscall"
)

type ownedProcess struct {
	pid     int
	once    sync.Once
	failure error
}

func configureOwnedProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}
func ownProcess(command *exec.Cmd) (*ownedProcess, error) {
	return &ownedProcess{pid: command.Process.Pid}, nil
}
func (p *ownedProcess) Close() error {
	p.once.Do(func() {
		p.failure = syscall.Kill(-p.pid, syscall.SIGKILL)
		if p.failure == syscall.ESRCH {
			p.failure = nil
		}
	})
	return p.failure
}
