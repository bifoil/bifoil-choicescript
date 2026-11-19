import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  affectedProjects,
  discoverProjects,
  exists,
  projectSources,
  readProject,
  sameFileUri,
  sourceUri,
} from "../src/projects.js";

test("invalid RandomTest configuration reports its field and preserves neighboring discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil project options "));
  try {
    const invalid = [
      { options: null, message: /must be an object/ },
      { options: [], message: /must be an object/ },
      { options: "invalid", message: /must be an object/ },
      { options: { iterations: 0 }, message: /iterations/ },
      { options: { iterations: 1.5 }, message: /iterations/ },
      { options: { seed: "1" }, message: /seed/ },
      { options: { seed: Number.MAX_SAFE_INTEGER, iterations: 2 }, message: /seed range/ },
    ];
    for (const [index, example] of invalid.entries()) {
      const directory = path.join(root, `invalid${index}`);
      await mkdir(directory);
      await writeFile(path.join(directory, "choicescript.json"), JSON.stringify({ randomtest: example.options }));
    }
    await mkdir(path.join(root, "healthy/scenes"), { recursive: true });
    await writeFile(path.join(root, "healthy/scenes/startup.txt"), "*ending");
    const errors = new Map<string, string>();
    const found = await discoverProjects([root], (uri, message) => errors.set(uri, message));
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "healthy");
    assert.equal(errors.size, invalid.length);
    for (const [index, example] of invalid.entries())
      assert.match(
        errors.get(pathToFileURL(path.join(root, `invalid${index}/choicescript.json`)).href)!,
        example.message,
      );
    assert.equal((await discoverProjects([root])).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid configuration selects default directories and claims an absent startup without descending", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil configured roots "));
  try {
    const configured = path.join(root, "configured");
    await mkdir(path.join(configured, "scenes"), { recursive: true });
    await writeFile(path.join(configured, "scenes/startup.txt"), "*ending");
    await writeFile(path.join(configured, "choicescript.json"), JSON.stringify({ randomtest: {} }));
    const claimed = path.join(root, "claimed");
    await mkdir(path.join(claimed, "nested/scenes"), { recursive: true });
    await writeFile(path.join(claimed, "nested/scenes/startup.txt"), "*ending");
    await writeFile(path.join(claimed, "choicescript.json"), "{}");
    const explicit = path.join(root, "explicit");
    await mkdir(path.join(explicit, "story"), { recursive: true });
    await writeFile(path.join(explicit, "story/startup.txt"), "*ending");
    await writeFile(
      path.join(explicit, "choicescript.json"),
      JSON.stringify({ scenes: "story", assets: "assets", randomtest: { iterations: 1, seed: 0 } }),
    );
    const invalid = path.join(root, "absolute");
    await mkdir(invalid);
    await writeFile(path.join(invalid, "choicescript.json"), JSON.stringify({ scenes: path.parse(root).root }));
    const found = await discoverProjects([pathToFileURL(root).href, path.join(root, "absent")]);
    assert.equal(found.length, 2);
    const defaults = found.find((project) => project.root === configured)!;
    assert.equal(defaults.sceneDir, path.join(configured, "scenes"));
    assert.equal(defaults.assetDir, configured);
    assert.deepEqual(defaults.randomtest, {});
    const selected = found.find((project) => project.root === explicit)!;
    assert.equal(selected.sceneDir, path.join(explicit, "story"));
    assert.equal(selected.assetDir, path.join(explicit, "assets"));
    assert.deepEqual(selected.randomtest, { iterations: 1, seed: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project discovery honors its depth boundary and generated-directory exclusions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil discovery depth "));
  try {
    const eighth = path.join(root, ...Array.from({ length: 8 }, (_, i) => `eight${i}`));
    const ninth = path.join(root, ...Array.from({ length: 9 }, (_, i) => `nine${i}`));
    for (const directory of [eighth, ninth, path.join(root, "dist/scenes"), path.join(root, ".hidden/scenes")]) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "startup.txt"), "*ending");
    }
    const found = await discoverProjects([root]);
    assert.deepEqual(
      found.map((project) => project.sceneDir),
      [eighth],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source enumeration ignores unrelated buffers and hidden directories without changing caller snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil source membership "));
  try {
    const scenes = path.join(root, "scenes");
    for (const directory of [
      scenes,
      path.join(scenes, "nested"),
      path.join(scenes, ".hidden"),
      path.join(scenes, "dist"),
    ]) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "startup.txt"), "*ending");
    }
    const project = { id: pathToFileURL(scenes).href, name: "Original", root, sceneDir: scenes, assetDir: root };
    const buffers = [
      { uri: pathToFileURL(path.join(root, "outside.txt")).href, text: "Outside", version: 1 },
      { uri: pathToFileURL(path.join(scenes, "image.png")).href, text: "Asset", version: 2 },
      { uri: "untitled:original", text: "Unsaved unrelated", version: 3 },
    ];
    const before = structuredClone(buffers);
    const sources = await projectSources(project, buffers);
    assert.deepEqual(
      sources.map((source) => path.relative(scenes, source.file)).sort(),
      [path.join("nested", "startup.txt"), "startup.txt"].sort(),
    );
    assert.ok(sources.every((source) => source.buffer === undefined));
    assert.deepEqual(buffers, before);
    assert.deepEqual(affectedProjects([project], "untitled:original"), []);
    assert.equal(sameFileUri("untitled:first", "untitled:first"), true);
    assert.equal(sameFileUri("untitled:first", "untitled:second"), false);
    assert.equal(sourceUri(["untitled:first"], "untitled:second"), undefined);
    assert.equal(sourceUri(["untitled:first"], "untitled:first"), "untitled:first");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project reads preserve disk versions and copy supplied snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil project reads Ω "));
  try {
    const startup = path.join(root, "startup.txt");
    const disk = path.join(root, "chapter.txt");
    await writeFile(startup, "Original disk startup.");
    await writeFile(disk, "Original chapter Ω.");
    const project = { id: pathToFileURL(root).href, name: "Original", root, sceneDir: root, assetDir: root };
    const snapshot = { uri: pathToFileURL(startup).href, text: "Unsaved Ω startup.", version: 17 };
    const expected = structuredClone(snapshot);
    assert.equal(await exists(startup), true);
    assert.equal(await exists(path.join(root, "absent.txt")), false);
    const sources = await readProject(project, [snapshot]);
    assert.equal(sources.length, 2);
    assert.deepEqual(
      sources.find((source) => source.uri === snapshot.uri),
      expected,
    );
    assert.notEqual(
      sources.find((source) => source.uri === snapshot.uri),
      snapshot,
    );
    assert.deepEqual(
      sources.find((source) => source.uri === pathToFileURL(disk).href),
      { uri: pathToFileURL(disk).href, text: "Original chapter Ω.", version: 0 },
    );
    assert.deepEqual(snapshot, expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed configurations isolate failures from healthy neighboring games", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil discovery "));

  try {
    for (const [name, config] of [
      ["null", "null"],
      ["array", "[]"],
      ["broken", "{"],
      ["paths", '{"assets":2}'],
      ["seeds", '{"randomtest":{"seed":9007199254740991}}'],
    ]) {
      await mkdir(path.join(root, name));
      await writeFile(path.join(root, name, "choicescript.json"), config);
    }

    await mkdir(path.join(root, "healthy/scenes"), { recursive: true });
    await writeFile(path.join(root, "healthy/scenes/startup.txt"), "*ending");

    const errors: string[] = [];
    const projects = await discoverProjects([root], (_, message) => errors.push(message));

    assert.equal(errors.length, 5);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, "healthy");
    assert.equal(affectedProjects(projects, pathToFileURL(path.join(root, "healthy/image.png")).href).length, 1);
    assert.equal(affectedProjects(projects, pathToFileURL(path.join(root, "other.txt")).href).length, 0);
    assert.equal(
      affectedProjects(projects, pathToFileURL(path.join(root, "healthy/.bifoil-choicescript/logs/job.log")).href)
        .length,
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source, configuration and asset notifications invalidate exactly their owning project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil project changes "));
  try {
    const project = {
      id: "original",
      name: "Original",
      root,
      sceneDir: path.join(root, "scenes"),
      assetDir: path.join(root, "assets"),
    };
    const other = {
      id: "other",
      name: "Other",
      root: path.join(root, "other"),
      sceneDir: path.join(root, "other/scenes"),
      assetDir: path.join(root, "other/assets"),
    };
    for (const file of [
      path.join(project.sceneDir, "startup.txt"),
      path.join(root, "choicescript.json"),
      path.join(project.assetDir, "image.png"),
    ])
      assert.deepEqual(affectedProjects([project, other], pathToFileURL(file).href), [project]);
    for (const file of [
      path.join(project.sceneDir, ".hidden/startup.txt"),
      path.join(project.assetDir, "export/output.html"),
      path.join(project.assetDir, "build/generated.png"),
      path.join(project.assetDir, ".hidden/image.png"),
      path.join(root, "unrelated.txt"),
    ])
      assert.deepEqual(affectedProjects([project], pathToFileURL(file).href), []);
    assert.deepEqual(affectedProjects([project, other], pathToFileURL(path.join(other.sceneDir, "startup.txt")).href), [
      other,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
