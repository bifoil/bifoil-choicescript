package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProjectConfigAcceptsEquivalentJSONSafeIntegers(t *testing.T) {
	for _, text := range []string{
		`{"randomtest":{"iterations":100,"seed":-2}}`,
		`{"randomtest":{"iterations":100.0,"seed":-2.0}}`,
		`{"randomtest":{"iterations":1e2,"seed":-2e0}}`,
	} {
		file := filepath.Join(t.TempDir(), "choicescript.json")
		if err := os.WriteFile(file, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
		config, err := readProjectConfig(file)
		if err != nil || config.RandomTest == nil || *config.RandomTest.Iterations != 100 || *config.RandomTest.Seed != -2 {
			t.Fatalf("%s: %+v %v", text, config, err)
		}
	}
	for _, number := range []string{`1.5`, `"1"`, `null`, `1e20`, `0`, `-1`} {
		file := filepath.Join(t.TempDir(), "choicescript.json")
		if err := os.WriteFile(file, []byte(`{"randomtest":{"iterations":`+number+`}}`), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readProjectConfig(file); err == nil {
			t.Fatalf("accepted invalid iterations %s", number)
		}
	}
}
