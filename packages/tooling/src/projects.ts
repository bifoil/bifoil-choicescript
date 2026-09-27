import { URI } from 'vscode-uri';
import { readdir, readFile, access, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { Project, BufferSnapshot } from '../../protocol/src/index.js';
const excluded = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.cache',
  '.idea',
  '.gradle',
]);
export async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
export async function discoverProjects(roots: string[]): Promise<Project[]> {
  const projects = new Map<string, Project>();
  async function walk(dir: string, depth: number) {
    if (depth > 8) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === 'choicescript.json')) {
      const config = JSON.parse(await readFile(path.join(dir, 'choicescript.json'), 'utf8'));
      config.scenes ??= 'scenes';
      if (typeof config.scenes !== 'string')
        throw new Error(`choicescript.json in ${dir}: scenes must be a relative directory.`);
      const scenes = path.resolve(dir, config.scenes);
      if (await exists(path.join(scenes, 'startup.txt')))
        projects.set(scenes, {
          id: URI.file(scenes).toString(),
          root: dir,
          sceneDir: scenes,
          assetDir: path.resolve(dir, config.assets ?? '.'),
          name: path.basename(dir),
          randomtest: config.randomtest,
        });
      return;
    }
    if (entries.some((e) => e.name.toLowerCase() === 'startup.txt')) {
      const game = path.basename(dir) === 'scenes' ? path.dirname(dir) : dir;
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
      if (e.isDirectory() && !excluded.has(e.name) && !e.name.startsWith('.'))
        await walk(path.join(dir, e.name), depth + 1);
  }
  for (const root of roots) await walk(root.startsWith('file:') ? fileURLToPath(root) : root, 0);
  return [...projects.values()];
}
export function contains(directory: string, file: string) {
  const rel = path.relative(directory, file);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
export function projectFor(projects: Project[], uri: string) {
  if (!uri.startsWith('file:')) return undefined;
  const file = fileURLToPath(uri);
  return projects
    .filter((p) => contains(p.sceneDir, file))
    .sort((a, b) => b.sceneDir.length - a.sceneDir.length)[0];
}
export async function readProject(project: Project, buffers: BufferSnapshot[] = []) {
  const files: BufferSnapshot[] = [];
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory() && !excluded.has(e.name)) await walk(file);
      else if (e.isFile() && e.name.endsWith('.txt')) {
        const uri = URI.file(file).toString();
        files.push(
          buffers.find((b) => fileURLToPath(b.uri) === fileURLToPath(uri)) ?? {
            uri,
            text: await readFile(file, 'utf8'),
            version: 0,
          },
        );
      }
    }
  }
  await walk(project.sceneDir);
  for (const b of buffers)
    if (projectFor([project], b.uri) && !files.some((f) => f.uri === b.uri)) files.push(b);
  return files;
}
