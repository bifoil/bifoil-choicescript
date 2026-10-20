package main

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

func nativeProjectContains(project gameProject, file string) bool {
	if project.SingleFile == "" {
		return strings.EqualFold(filepath.Ext(file), ".txt") && inside(project.SceneDir, file)
	}
	if filepath.Clean(project.SingleFile) == filepath.Clean(file) {
		return true
	}
	if !strings.EqualFold(filepath.Base(project.SingleFile), filepath.Base(file)) {
		return false
	}
	left, e1 := os.Stat(project.SingleFile)
	right, e2 := os.Stat(file)
	return e1 == nil && e2 == nil && os.SameFile(left, right)
}

// Explicit language selection enables only that file, including an unsaved new
// file. It never claims neighboring text files or presents a loose file as a game.
func standaloneNativeProjects(projects []gameProject, buffers map[string]openBuffer) []gameProject {
	uris := make([]string, 0, len(buffers))
	for uri, buffer := range buffers {
		if buffer.Explicit {
			uris = append(uris, uri)
		}
	}
	sort.Strings(uris)
	for _, uri := range uris {
		file, err := uriPath(uri)
		if err != nil {
			continue
		}
		claimed := false
		for _, project := range projects {
			if nativeProjectContains(project, file) {
				claimed = true
				break
			}
		}
		if !claimed {
			projects = append(projects, gameProject{ID: pathURI(file), Root: filepath.Dir(file), SceneDir: filepath.Dir(file), AssetDir: filepath.Dir(file), Name: filepath.Base(file), SingleFile: file})
		}
	}
	return projects
}
func detectedNativeProjects(projects []gameProject) []gameProject {
	result := make([]gameProject, 0, len(projects))
	for _, project := range projects {
		if project.SingleFile == "" {
			result = append(result, project)
		}
	}
	return result
}
func loadNativeProject(ctx context.Context, game gameProject, p *core.Project, buffers map[string]openBuffer, cache *parseCache) (int64, int, int, error) {
	if game.SingleFile == "" {
		return loadDirectoryBuffers(ctx, game.SceneDir, p, buffers, cache)
	}
	parsed, bytes, err := parseNativeSource(ctx, game.SingleFile, buffers, cache)
	if err != nil {
		return 0, 0, 0, err
	}
	d := p.AddParsed(parsed)
	return int64(bytes), 1, d.RowCount() - 1, nil
}
