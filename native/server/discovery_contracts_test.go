package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestProjectDiscoveryIsBoundedAndRetainsConfiguredPaths(t *testing.T) {
	root := t.TempDir()
	write := func(relative, text string) string {
		t.Helper()
		file := filepath.Join(root, relative)
		if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
		return file
	}
	write("configured/choicescript.json", `{"scenes":"chapters","assets":"media","randomtest":{"iterations":2,"seed":-9}}`)
	write("configured/chapters/startup.txt", "Original configured story.")
	write("defaults/choicescript.json", `{}`)
	write("defaults/scenes/startup.txt", "Original default story.")
	write("flat/STARTUP.TXT", "Original flat story.")
	write("broken/choicescript.json", `null`)
	write("missing/choicescript.json", `{"scenes":"absent"}`)
	for _, folder := range []string{"vendor", "node_modules", "dist", "build", ".hidden"} {
		write(filepath.Join(folder, "scenes/startup.txt"), "Excluded generated story.")
	}
	write(filepath.Join("deep", strings.Repeat("nested/", 9), "startup.txt"), "Beyond the discovery depth.")
	if err := os.MkdirAll(filepath.Join(root, "unreadable/choicescript.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "directory/startup.txt"), 0700); err != nil {
		t.Fatal(err)
	}
	reports := make(map[string]string)
	projects := discoverNativeProjects([]string{pathURI(root), root, filepath.Join(root, "absent"), "file:///invalid?query=1"}, func(uri, message string) { reports[uri] = message })
	if len(projects) != 3 || len(reports) != 2 {
		t.Fatalf("unexpected discovered projects or reports: %+v %+v", projects, reports)
	}
	if !slices.IsSortedFunc(projects, func(a, b gameProject) int { return strings.Compare(a.ID, b.ID) }) {
		t.Fatal("project ordering is not stable")
	}
	for _, project := range projects {
		if project.Name == "configured" {
			if project.SceneDir != filepath.Join(root, "configured/chapters") || project.AssetDir != filepath.Join(root, "configured/media") || project.RandomTest == nil || *project.RandomTest.Iterations != 2 || *project.RandomTest.Seed != -9 {
				t.Fatalf("configured paths or defaults were lost: %+v", project)
			}
		} else if project.Name == "defaults" {
			if project.Root != filepath.Join(root, "defaults") || project.AssetDir != project.Root {
				t.Fatal("default project roots changed", project)
			}
		} else if project.Name != "flat" {
			t.Fatal("claimed an unrelated directory", project)
		}
	}
	for _, message := range reports {
		if !strings.Contains(message, "Invalid choicescript.json") {
			t.Fatal("configuration failure was hidden", message)
		}
	}
}

func TestProjectConfigurationRejectsInvalidShapesAndAbsoluteDirectories(t *testing.T) {
	file := filepath.Join(t.TempDir(), "choicescript.json")
	if _, err := readProjectConfig(file); !os.IsNotExist(err) {
		t.Fatal("missing configuration did not preserve its filesystem error", err)
	}
	for _, text := range []string{
		`[]`, `null`, `{`, `{"scenes":null}`, `{"assets":42}`, `{"randomtest":null}`,
		`{"randomtest":[]}`, `{"randomtest":{"iterations":10000001}}`,
		`{"randomtest":{"iterations":2,"seed":9007199254740991}}`,
	} {
		if err := os.WriteFile(file, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readProjectConfig(file); err == nil {
			t.Fatal("accepted malformed project configuration", text)
		}
	}
	absolute := strings.ReplaceAll(filepath.Dir(file), `\`, `\\`)
	if err := os.WriteFile(file, []byte(`{"scenes":"`+absolute+`"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readProjectConfig(file); err == nil {
		t.Fatal("accepted an absolute scene path")
	}
}
