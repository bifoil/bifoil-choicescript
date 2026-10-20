//go:build !windows

package main

func availableHostMemoryBytes() int64 { return -1 }
