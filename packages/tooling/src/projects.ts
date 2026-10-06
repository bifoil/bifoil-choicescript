import { URI } from "vscode-uri";
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type BufferSnapshot,
  type Project,
  validIterations,
  validSeed,
  validSeedRange,
} from "@bifoil/choicescript-protocol";

const excluded = new Set([".git", "node_modules", "vendor", "dist", "build", ".cache", ".idea", ".gradle"]);

type ProjectConfiguration = {
  scenes?: string;
  assets?: string;
  randomtest?: Project["randomtest"];
};

/**
 * Validate known fields in strict parsed JSON. Unknown keys are currently ignored.
 * Relative paths may include parent traversal; this is configuration validation, not a
 * sandbox that confines explicitly selected roots to the config directory.
 */
function validateConfiguration(value: unknown): asserts value is ProjectConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");

  const config = value as Record<string, unknown>;

  for (const key of ["scenes", "assets"]) {
    const directory = config[key];

    if (directory !== undefined && (typeof directory !== "string" || path.isAbsolute(directory)))
      throw new Error(key + " must be a relative directory.");
  }

  if (config.randomtest !== undefined) {
    const value = config.randomtest;

    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("randomtest must be an object.");

    const options = value as Record<string, unknown>;
    const iterations = options.iterations === undefined ? 1000 : options.iterations;
    const seed = options.seed === undefined ? 0 : options.seed;

    if (!validIterations(iterations)) throw new Error("Invalid RandomTest iterations.");
    if (!validSeed(seed)) throw new Error("Invalid RandomTest seed.");
    if (!validSeedRange(seed, iterations)) throw new Error("RandomTest seed range exceeds safe integers.");
  }
}

/**
 * Best-effort accessibility check; false includes permission errors and is not a race-free existence guarantee.
 */
export async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function regularFile(file: string) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Discover games beneath filesystem paths or file-URI roots, through depth eight.
 * Valid configuration claims a root and stops descent even when startup.txt is absent.
 * Invalid configuration is reported and discovery continues. Ordinary descendant directory
 * symlinks and hidden/generated directories are skipped; explicit roots can resolve links.
 * Does not load every scene or establish that the resulting project is runnable.
 */
export async function discoverProjects(
  roots: string[],
  report: (uri: string, message: string) => void = () => {},
): Promise<Project[]> {
  const projects = new Map<string, Project>();

  async function walk(dir: string, depth: number) {
    if (depth > 8) return;

    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((e) => e.name === "choicescript.json")) {
      const configFile = path.join(dir, "choicescript.json");

      try {
        const config = JSON.parse(await readFile(configFile, "utf8"));
        validateConfiguration(config);

        const scenes = path.resolve(dir, config.scenes ?? "scenes");

        if (await regularFile(path.join(scenes, "startup.txt")))
          projects.set(scenes, {
            id: URI.file(scenes).toString(),
            root: dir,
            sceneDir: scenes,
            assetDir: path.resolve(dir, config.assets ?? "."),
            name: path.basename(dir),
            randomtest: config.randomtest,
          });

        return;
      } catch (error) {
        report(pathToFileURL(configFile).href, "Invalid choicescript.json: " + String(error));
        // A bad configuration must not hide healthy games in this workspace.
      }
    }

    const startup = entries.find((e) => e.name.toLowerCase() === "startup.txt");

    if (startup && (await regularFile(path.join(dir, startup.name)))) {
      const game = path.basename(dir) === "scenes" ? path.dirname(dir) : dir;
      projects.set(dir, {
        id: URI.file(dir).toString(),
        root: game,
        sceneDir: dir,
        assetDir: game,
        name: path.basename(game),
      });
      return;
    }

    for (const e of entries)
      if (e.isDirectory() && !excluded.has(e.name) && !e.name.startsWith("."))
        await walk(path.join(dir, e.name), depth + 1);
  }

  for (const root of roots) await walk(root.startsWith("file:") ? fileURLToPath(root) : root, 0);

  return [...projects.values()];
}

/**
 * Lexical path containment using the host path implementation, including equality.
 * Does not resolve symlinks or authorize filesystem access; use realpath checks where
 * serving files requires physical containment.
 */
export function contains(directory: string, file: string) {
  const rel = path.relative(directory, file);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

/**
 * Find the deepest containing scene root for a file URI. This tests membership, not the file's extension or existence.
 */
export function projectFor(projects: Project[], uri: string) {
  if (!uri.startsWith("file:")) return undefined;

  const file = fileURLToPath(uri);
  return projects.filter((p) => contains(p.sceneDir, file)).sort((a, b) => b.sceneDir.length - a.sceneDir.length)[0];
}

/**
 * Compare normalized file paths case-insensitively on Windows; non-file identifiers use exact string equality.
 */
export function sameFileUri(left: string, right: string) {
  if (!left.startsWith("file:") || !right.startsWith("file:")) return left === right;

  const a = path.resolve(fileURLToPath(left)),
    b = path.resolve(fileURLToPath(right));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Source identity without eagerly loading text. buffer, when present, overrides disk
 * and can represent a newly created unsaved scene; file remains an absolute host path.
 */
export interface ProjectSource {
  uri: string;
  file: string;
  buffer?: BufferSnapshot;
}

/**
 * Enumerate regular .txt sources recursively, overlaying copies of supplied open buffers.
 * Includes in-project unsaved .txt buffers absent from disk. Checks cancellation during
 * traversal and propagates I/O errors. Nested sources are valid for enumeration but the
 * official runtime staging layer imposes its own flat-scene restriction.
 */
export async function projectSources(
  project: Project,
  buffers: BufferSnapshot[] = [],
  signal?: AbortSignal,
): Promise<ProjectSource[]> {
  const sources: ProjectSource[] = [];

  const key = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file));

  const open = new Map(
    buffers
      .filter((buffer) => projectFor([project], buffer.uri))
      .map((buffer) => [key(fileURLToPath(buffer.uri)), { ...buffer }]),
  );
  const seen = new Set<string>();

  async function walk(dir: string) {
    signal?.throwIfAborted();

    for (const entry of await readdir(dir, { withFileTypes: true })) {
      signal?.throwIfAborted();

      const file = path.join(dir, entry.name);

      if (entry.isDirectory() && !excluded.has(entry.name) && !entry.name.startsWith(".")) await walk(file);
      else if (entry.isFile() && /\.txt$/i.test(entry.name)) {
        const identity = key(file),
          buffer = open.get(identity);
        sources.push({ file, uri: buffer?.uri ?? pathToFileURL(file).href, buffer });
        seen.add(identity);
      }
    }
  }

  await walk(project.sceneDir);

  for (const [identity, buffer] of open)
    if (!seen.has(identity) && /\.txt$/i.test(fileURLToPath(buffer.uri))) {
      sources.push({ file: fileURLToPath(buffer.uri), uri: buffer.uri, buffer });
      seen.add(identity);
    }

  return sources;
}

/**
 * Materialize every source into buffer snapshots (disk versions use 0).
 * This is the eager convenience API; large-game indexing should use projectSources
 * instead of retaining all source text. Supplied buffers take precedence over disk.
 */
export async function readProject(project: Project, buffers: BufferSnapshot[] = [], signal?: AbortSignal) {
  const files: BufferSnapshot[] = [];

  for (const source of await projectSources(project, buffers, signal)) {
    signal?.throwIfAborted();
    files.push(
      source.buffer ?? { uri: source.uri, text: await readFile(source.file, { encoding: "utf8", signal }), version: 0 },
    );
  }

  return files;
}

/**
 * Map a notified source/config/asset URI to games whose tool snapshots may be stale.
 * Hidden/generated paths and conventional export output are excluded. This function
 * only classifies notifications it receives; editor watcher coverage is a separate duty.
 */
export function affectedProjects(projects: Project[], uri: string): Project[] {
  if (!uri.startsWith("file:")) return [];

  const file = fileURLToPath(uri);
  return projects.filter((project) => {
    if (contains(project.sceneDir, file)) {
      const relative = path.relative(project.sceneDir, file);
      return !relative.split(path.sep).some((name) => name.startsWith(".") || excluded.has(name));
    }

    if (sameFileUri(uri, pathToFileURL(path.join(project.root, "choicescript.json")).href)) return true;
    if (!contains(project.assetDir, file)) return false;

    return !path
      .relative(project.assetDir, file)
      .split(path.sep)
      .some((name) => excluded.has(name) || name.startsWith(".") || name === "export");
  });
}
