package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Go's coverage runtime supports using an instrumented test binary as the tool
// under test. Children inherit GOCOVERDIR, so their real entry-point counters are
// included by the parent's normal coverage teardown without changing main().
func TestMain(m *testing.M) {
	if os.Getenv("BIFOIL_TEST_NATIVE_ENTRY") == "1" {
		main()
		return
	}
	os.Exit(m.Run())
}

func runNativeEntry(t *testing.T, arguments []string, input string, environment map[string]string) (string, string, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, executable, arguments...)
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "BIFOIL_NATIVE_") && !strings.HasPrefix(value, "BIFOIL_TEST_NATIVE_ENTRY=") {
			cmd.Env = append(cmd.Env, value)
		}
	}
	cmd.Env = append(cmd.Env, "BIFOIL_TEST_NATIVE_ENTRY=1")
	for key, value := range environment {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	cmd.Stdin = strings.NewReader(input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err = cmd.Run()
	if ctx.Err() != nil {
		t.Fatal("native entry did not terminate", ctx.Err())
	}
	status := 0
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			t.Fatal(err)
		}
		status = exit.ExitCode()
	}
	return stdout.String(), stderr.String(), status
}

func TestNativeEntryRejectsInvalidOptionsWithStableExitCodes(t *testing.T) {
	for _, scenario := range []struct {
		args    []string
		env     map[string]string
		code    int
		message string
	}{
		{nil, nil, 2, "Use --analyze"},
		{[]string{"--stdio", "--node"}, nil, 2, "Missing server option value"},
		{[]string{"--stdio", "--unexpected", "value"}, nil, 2, "Unknown server option"},
		{[]string{"--stdio"}, map[string]string{"BIFOIL_NATIVE_MEMORY_LIMIT_MIB": "not-a-number"}, 2, "Invalid native memory target"},
		{[]string{"--stdio"}, map[string]string{"BIFOIL_NATIVE_MEMORY_LIMIT_MIB": "31"}, 2, "Invalid native memory target"},
		{[]string{"--stdio"}, map[string]string{"BIFOIL_NATIVE_MEMORY_LIMIT_MIB": "193"}, 2, "Invalid native memory target"},
		{[]string{"--analyze", filepath.Join(t.TempDir(), "missing")}, nil, 1, ""},
	} {
		_, stderr, code := runNativeEntry(t, scenario.args, "", scenario.env)
		if code != scenario.code || !strings.Contains(stderr, scenario.message) {
			t.Fatalf("%v: exit=%d stderr=%s", scenario.args, code, stderr)
		}
	}
}

func TestNativeEntryAnalysisAndStdioReleaseTheirProfiles(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "startup.txt"), []byte("*create n 1\n*print n\nOriginal three words.\n*ending"), 0600); err != nil {
		t.Fatal(err)
	}
	profile := filepath.Join(root, "analysis.pprof")
	stdout, stderr, code := runNativeEntry(t, []string{"--analyze", root}, "", map[string]string{"BIFOIL_NATIVE_MEMORY_LIMIT_MIB": "64", "BIFOIL_NATIVE_CPU_PROFILE": profile})
	var report struct{ Files, Words, InvalidTokens int }
	if code != 0 || json.Unmarshal([]byte(stdout), &report) != nil || report.Files != 1 || report.Words != 3 || report.InvalidTokens != 0 {
		t.Fatalf("analysis failed: %d %s %s", code, stdout, stderr)
	}
	if info, err := os.Stat(profile); err != nil || info.Size() == 0 {
		t.Fatal("CPU profile was not flushed", err)
	}
	for _, args := range [][]string{{"--stdio"}, {"--stdio", "--bundle-root", root, "--node", "unused"}} {
		_, stderr, code = runNativeEntry(t, args, "", map[string]string{"BIFOIL_NATIVE_CPU_PROFILE": filepath.Join(root, "stdio.pprof")})
		if code != 0 {
			t.Fatal(code, stderr)
		}
	}
	_, _, code = runNativeEntry(t, []string{"--stdio"}, "Content-Length: 1\r\n\r\n{", nil)
	if code != 1 {
		t.Fatal("invalid transport was accepted", code)
	}
	for _, mode := range []string{"--stdio", "--analyze"} {
		args := []string{mode}
		if mode == "--analyze" {
			args = append(args, root)
		}
		_, _, code = runNativeEntry(t, args, "", map[string]string{"BIFOIL_NATIVE_CPU_PROFILE": filepath.Join(root, "absent/profile")})
		if code != 1 {
			t.Fatal("invalid profile destination accepted", mode, code)
		}
	}
	_, _, code = runNativeEntry(t, []string{"--analyze", root}, "", map[string]string{"BIFOIL_NATIVE_ANALYSIS_TIMEOUT": "invalid"})
	if code != 1 {
		t.Fatal("invalid analysis timeout accepted", code)
	}
}
