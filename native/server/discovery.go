package main

import (
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

type randomDefaults struct {
	Iterations *int64 `json:"iterations,omitempty"`
	Seed       *int64 `json:"seed,omitempty"`
}
type gameProject struct {
	SingleFile string          `json:"-"`
	ID         string          `json:"id"`
	Root       string          `json:"root"`
	SceneDir   string          `json:"sceneDir"`
	AssetDir   string          `json:"assetDir"`
	Name       string          `json:"name"`
	RandomTest *randomDefaults `json:"randomtest,omitempty"`
}
type projectConfig struct {
	Scenes     *string         `json:"scenes"`
	Assets     *string         `json:"assets"`
	RandomTest *randomDefaults `json:"randomtest"`
}

const maxSafeInteger int64 = 9007199254740991

func pathURI(file string) string {
	file = filepath.ToSlash(file)
	if runtime.GOOS == "windows" && !strings.HasPrefix(file, "/") {
		file = "/" + file
	}
	return (&url.URL{Scheme: "file", Path: file}).String()
}
func uriPath(uri string) (string, error) {
	parsed, err := url.Parse(uri)
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "file" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Host != "" && parsed.Host != "localhost" {
		return "", errors.New("expected a local file URI")
	}
	file := parsed.Path
	if runtime.GOOS == "windows" && len(file) > 2 && file[0] == '/' && file[2] == ':' {
		file = file[1:]
	}
	return filepath.FromSlash(file), nil
}
func inside(root, file string) bool {
	relative, err := filepath.Rel(root, file)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}
func validRandom(r *randomDefaults) bool {
	if r == nil {
		return true
	}
	iterations, seed := int64(1000), int64(0)
	if r.Iterations != nil {
		iterations = *r.Iterations
	}
	if r.Seed != nil {
		seed = *r.Seed
	}
	return iterations >= 1 && iterations <= 10000000 && seed >= -maxSafeInteger && seed <= maxSafeInteger-(iterations-1)
}
func readProjectConfig(file string) (projectConfig, error) {
	var result projectConfig
	data, err := os.ReadFile(file)
	if err != nil {
		return result, err
	}
	var object map[string]json.RawMessage
	if err = json.Unmarshal(data, &object); err != nil || object == nil {
		return result, errors.New("expected a configuration object")
	}
	for _, key := range []string{"scenes", "assets"} {
		if value, present := object[key]; present {
			var text string
			if err = json.Unmarshal(value, &text); err != nil || string(value) == "null" || filepath.IsAbs(text) {
				return result, errors.New(key + " must be a relative directory")
			}
		}
	}
	if value, present := object["randomtest"]; present {
		var options map[string]json.RawMessage
		if err = json.Unmarshal(value, &options); err != nil || options == nil {
			return result, errors.New("randomtest must be an object")
		}
		result.RandomTest = new(randomDefaults)
		for _, key := range []string{"iterations", "seed"} {
			if number, present := options[key]; present {
				var n float64
				if err = json.Unmarshal(number, &n); err != nil || string(number) == "null" || math.Trunc(n) != n || math.Abs(n) > float64(maxSafeInteger) {
					return result, errors.New("invalid randomtest number")
				}
				integer := int64(n)
				if key == "iterations" {
					result.RandomTest.Iterations = &integer
				} else {
					result.RandomTest.Seed = &integer
				}
			}
		}
	}
	// JSON 1, 1.0 and 1e0 are the same safe integer under the shared protocol.
	// Convert validated numeric options above instead of decoding them as int64.
	var paths struct {
		Scenes *string `json:"scenes"`
		Assets *string `json:"assets"`
	}
	if err = json.Unmarshal(data, &paths); err != nil {
		return result, err
	}
	result.Scenes, result.Assets = paths.Scenes, paths.Assets
	if !validRandom(result.RandomTest) {
		return result, errors.New("invalid RandomTest defaults")
	}
	return result, nil
}

var discoveryExcluded = map[string]bool{"node_modules": true, "vendor": true, "dist": true, "build": true}

func discoverNativeProjects(roots []string, report func(string, string)) []gameProject {
	projects := make(map[string]gameProject)
	var walk func(string, int)
	walk = func(dir string, depth int) {
		if depth > 8 {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		configFile := filepath.Join(dir, "choicescript.json")
		for _, entry := range entries {
			if entry.Name() == "choicescript.json" {
				config, e := readProjectConfig(configFile)
				if e != nil {
					report(pathURI(configFile), "Invalid choicescript.json: "+e.Error())
					break
				}
				scenes, assets := "scenes", "."
				if config.Scenes != nil {
					scenes = *config.Scenes
				}
				if config.Assets != nil {
					assets = *config.Assets
				}
				scenes = filepath.Clean(filepath.Join(dir, scenes))
				assets = filepath.Clean(filepath.Join(dir, assets))
				if info, e := os.Stat(filepath.Join(scenes, "startup.txt")); e == nil && info.Mode().IsRegular() {
					projects[scenes] = gameProject{ID: pathURI(scenes), Root: dir, SceneDir: scenes, AssetDir: assets, Name: filepath.Base(dir), RandomTest: config.RandomTest}
				}
				return
			}
		}
		for _, entry := range entries {
			if strings.EqualFold(entry.Name(), "startup.txt") {
				if info, e := os.Stat(filepath.Join(dir, entry.Name())); e == nil && info.Mode().IsRegular() {
					root := dir
					if filepath.Base(dir) == "scenes" {
						root = filepath.Dir(dir)
					}
					projects[dir] = gameProject{ID: pathURI(dir), Root: root, SceneDir: dir, AssetDir: root, Name: filepath.Base(root)}
					return
				}
			}
		}
		for _, entry := range entries {
			if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") && !discoveryExcluded[entry.Name()] {
				walk(filepath.Join(dir, entry.Name()), depth+1)
			}
		}
	}
	for _, root := range roots {
		if strings.HasPrefix(root, "file:") {
			var err error
			root, err = uriPath(root)
			if err != nil {
				continue
			}
		}
		if absolute, e := filepath.Abs(root); e == nil {
			walk(absolute, 0)
		}
	}
	result := make([]gameProject, 0, len(projects))
	for _, p := range projects {
		result = append(result, p)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}
