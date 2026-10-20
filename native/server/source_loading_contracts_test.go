package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

func TestLoadingOwnsUnsavedSourcesAndRejectsExternalAliases(t *testing.T) {
	root := t.TempDir()
	startup := filepath.Join(root, "startup.txt")
	disk := "*create score 1\n*ending"
	unsaved := "*create score true\n*print score\n*ending"
	if err := os.WriteFile(startup, []byte(disk), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, ".hidden"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".hidden", "secret.txt"), []byte("Hidden original source"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "directory.txt"), 0700); err != nil {
		t.Fatal(err)
	}
	draft := filepath.Join(root, "draft.TXT")
	buffers := map[string]openBuffer{
		pathURI(startup): {URI: pathURI(startup), Text: unsaved, Version: 3},
		pathURI(draft):   {URI: pathURI(draft), Text: "Original unsaved prose.\n*ending", Version: 4},
		pathURI(filepath.Join(root, "directory.txt")):     {Text: "Not a regular source"},
		pathURI(filepath.Join(root, "notes.md")):          {Text: "Not a scene"},
		pathURI(filepath.Join(root, "..", "outside.txt")): {Text: "Outside game"},
		"https://invalid/startup.txt":                     {Text: "Nonlocal URI"},
	}
	p := core.NewProject()
	bytes, files, rows, err := loadDirectoryBuffers(context.Background(), root, p, buffers)
	if err != nil || files != 2 || rows != 5 || bytes != int64(len(unsaved)+len("Original unsaved prose.\n*ending")) {
		t.Fatal("source inventory changed", bytes, files, rows, err)
	}
	if err = p.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	index, ok := nativeDocumentIndex(p, pathURI(startup))
	if !ok {
		t.Fatal("buffered source not indexed")
	}
	if _, ok = nativeDocumentIndex(p, "https://invalid/startup.txt"); ok {
		t.Fatal("nonlocal URI resolved")
	}
	if _, ok = nativeDocumentIndex(p, pathURI(filepath.Join(root, "missing.txt"))); ok {
		t.Fatal("absent source resolved")
	}
	if index >= uint32(len(p.Documents)) || p.Documents[index].Version != 3 {
		t.Fatal("unsaved revision was not retained")
	}
	original, err := os.ReadFile(startup)
	if err != nil || string(original) != disk {
		t.Fatal("loading rewrote disk source")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, _, err = loadDirectoryBuffers(cancelled, root, core.NewProject(), nil); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled source traversal continued", err)
	}
	if _, _, err = parseNativeSource(context.Background(), filepath.Join(root, "missing.txt"), nil, nil); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("missing source error hidden", err)
	}
	if _, _, err = parseNativeSource(cancelled, startup, nil, nil); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled small source parsing continued", err)
	}
}

func TestSmallSourceReaderHandlesGrowthAndClosedInputs(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "source-")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	text := "Original 😀\r\nsecond line"
	if _, err = file.WriteString(text); err != nil {
		t.Fatal(err)
	}
	if _, err = file.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	data, err := readSmallSource(context.Background(), file, 0)
	if err != nil || string(data) != text {
		t.Fatal("growth truncated source", string(data), err)
	}
	info, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if !sameDiskSnapshot(info, info) || sameDiskSnapshot(nil, info) || sameDiskSnapshot(info, nil) {
		t.Fatal("disk snapshot identity changed")
	}
	if _, err = file.WriteString("grown"); err != nil {
		t.Fatal(err)
	}
	after, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if sameDiskSnapshot(info, after) {
		t.Fatal("changed file retained cache identity")
	}
	file.Close()
	if _, err = readSmallSource(context.Background(), file, 10); err == nil {
		t.Fatal("closed source error hidden")
	}
	if _, err = readNativeSource(file.Name()+"missing", nil); err == nil {
		t.Fatal("missing source read succeeded")
	}
}
