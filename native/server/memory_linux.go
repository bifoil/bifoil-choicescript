package main

import (
	"os"
	"strconv"
	"strings"
)

func peakResidentMiB() float64 {
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return -1
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == "VmHWM:" {
			n, err := strconv.ParseFloat(fields[1], 64)
			if err == nil {
				return n / 1024
			}
		}
	}
	return -1
}

func linuxResidentBytes(pid int) int64 {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == "VmRSS:" {
			value, err := strconv.ParseInt(fields[1], 10, 64)
			if err == nil {
				return value * 1024
			}
		}
	}
	return 0
}
func currentResidentBytes() int64 { return linuxResidentBytes(os.Getpid()) }
func (p *ownedProcess) residentBytes() int64 {
	var total int64
	pending := []int{p.pid}
	seen := make(map[int]bool)
	for len(pending) > 0 {
		pid := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if seen[pid] {
			continue
		}
		seen[pid] = true
		total += linuxResidentBytes(pid)
		data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/task/" + strconv.Itoa(pid) + "/children")
		if err == nil {
			for _, field := range strings.Fields(string(data)) {
				child, err := strconv.Atoi(field)
				if err == nil {
					pending = append(pending, child)
				}
			}
		}
	}
	return total
}
