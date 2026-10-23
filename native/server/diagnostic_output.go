package main

import (
	"fmt"
	"os"
)

// Ignore diagnostic write failures: a closed stderr must not corrupt LSP stdout
// or turn optional tracing into a language-service failure.
func writeStderr(values ...any) {
	_, _ = fmt.Fprintln(os.Stderr, values...)
}

func writeStderrf(format string, values ...any) {
	_, _ = fmt.Fprintf(os.Stderr, format, values...)
}

func closeNativeFile(file *os.File) {
	if err := file.Close(); err != nil {
		writeStderr("Could not close native file:", err)
	}
}

func removeNativeTemporaryDirectory(directory string) {
	if err := os.RemoveAll(directory); err != nil {
		writeStderr("Could not remove native temporary directory:", err)
	}
}
