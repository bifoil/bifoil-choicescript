package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestDarwinResidentAccountingSurvivesBrokerParentExit(t *testing.T) {
	node := os.Getenv("BIFOIL_TEST_NODE")
	if node == "" {
		var err error
		node, err = exec.LookPath("node")
		if err != nil {
			t.Skip("Node is required for owned process integration")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	program := `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();console.log(child.pid);`
	command := exec.CommandContext(ctx, node, "-e", program)
	var output bytes.Buffer
	command.Stdout = &output
	configureOwnedProcess(command)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	owner, err := ownProcess(command)
	if err != nil {
		_ = command.Process.Kill()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := owner.Close(); err != nil {
			t.Error(err)
		}
	})
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(output.String()))
	if err != nil || pid <= 0 {
		t.Fatalf("missing owned descendant PID: %q", output.String())
	}
	if memory := owner.residentBytes(); memory <= 0 {
		t.Fatalf("reparented descendant was not counted: %d", memory)
	}
	if currentResidentBytes() <= 0 || peakResidentMiB() <= 0 {
		t.Fatal("server resident accounting is unavailable")
	}
	if darwinResidentBytes(-1) != -1 {
		t.Fatal("invalid PID was reported as a measurement")
	}
}
