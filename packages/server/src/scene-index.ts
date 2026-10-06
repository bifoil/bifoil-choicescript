import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type ProjectSource, projectSources, sameFileUri } from "@bifoil/choicescript-tooling";
import type { Project } from "@bifoil/choicescript-protocol";

/**
 * Scene identity plus optional compressed projection. full requests reparsing full source.
 * stamp is a server-issued invalidation identity, not an editor document version.
 * data can supply cached compressed bytes instead of reading cache from disk.
 */
export interface IndexedSource extends ProjectSource {
  cache?: string;
  full?: boolean;
  data?: Uint8Array;
  stamp?: number;
}

/**
 * Owns one game's source inventory and temporary projection files.
 * Generation checks reject late inventory/index results after invalidation. cached maps
 * URIs to files, failed records per-file errors, and stamps identify accepted projections.
 * Call dispose() after the owning project/session is retired.
 */
export class SceneIndex {
  sources?: ProjectSource[];
  readonly cached = new Map<string, string>();
  readonly failed = new Map<string, string>();
  readonly stamps = new Map<string, number>();
  nextStamp = 0;
  generation = 0;
  private directory?: Promise<string>;

  constructor(readonly project: Project) {}

  /**
   * Enumerate identities without reading scene contents; discard an enumeration superseded by invalidation.
   */
  async inventory(): Promise<ProjectSource[]> {
    if (this.sources) return this.sources;

    const generation = this.generation,
      sources = await projectSources(this.project);

    if (generation !== this.generation) return this.inventory();

    const present = new Set(sources.map((source) => source.uri));

    for (const uri of this.cached.keys())
      if (!present.has(uri)) {
        this.cached.delete(uri);
        this.stamps.delete(uri);
      }

    for (const uri of this.failed.keys()) if (!present.has(uri)) this.failed.delete(uri);

    return (this.sources = sources);
  }

  /**
   * Lazily allocate this index's owned temporary directory, reusing the in-flight allocation promise.
   */
  async cacheDirectory(): Promise<string> {
    return (this.directory ??= mkdtemp(path.join(os.tmpdir(), "bifoil-scene-index-")));
  }

  /**
   * Invalidate one scene or the whole project and force membership enumeration again.
   * This drops bookkeeping, not each old file immediately; dispose owns directory removal.
   */
  invalidate(uri?: string) {
    this.generation++;

    if (!uri) {
      this.sources = undefined;
      this.cached.clear();
      this.failed.clear();
      this.stamps.clear();
    } else {
      for (const key of this.cached.keys())
        if (sameFileUri(key, uri)) {
          this.cached.delete(key);
          this.stamps.delete(key);
        }

      for (const key of this.failed.keys()) if (sameFileUri(key, uri)) this.failed.delete(key);

      // Membership may have changed; enumeration itself does not read source text.
      this.sources = undefined;
    }
  }

  /**
   * Remove the owned projection directory. Stop workers that might write it before disposing the index.
   */
  async dispose() {
    if (this.directory) await rm(await this.directory, { recursive: true, force: true });
  }
}

/**
 * One process-wide budget, independent of game count and narrative volume.
 * LRU cache of compressed bytes. The byte limit covers stored Uint8Arrays only,
 * not decoded ASTs, open buffers, disk files, or total process RSS. Values are borrowed;
 * do not mutate or transfer-detach arrays still owned by this cache.
 */
export class SummaryCache {
  private bytes = 0;
  private readonly entries = new Map<string, Uint8Array>();

  constructor(private readonly limit = 8 * 1024 * 1024) {}

  get(key: string) {
    const value = this.entries.get(key);

    if (value) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }

    return value;
  }

  set(key: string, value: Uint8Array) {
    this.delete(key);
    if (value.byteLength > this.limit) return;
    while (this.bytes + value.byteLength > this.limit) this.delete(this.entries.keys().next().value!);

    this.entries.set(key, value);
    this.bytes += value.byteLength;
  }

  delete(key: string) {
    const value = this.entries.get(key);

    if (value) {
      this.bytes -= value.byteLength;
      this.entries.delete(key);
    }
  }
}
