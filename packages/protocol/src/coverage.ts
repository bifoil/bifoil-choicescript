import type { JobEvent } from "./index.js";

type Result = { jobId: string; stale: boolean; coverage?: Record<string, number[]> };

/** Retains only the current job's coverage for each game, including when no editor is visible. */
export class CoverageStore {
  private readonly results = new Map<string, Result>();

  /**
   * Apply an event only to the latest started job for its project.
   * Returns whether presentation should refresh. Staleness or failed completion clears
   * coverage; later coverage cannot revive that job. Input arrays are copied on acceptance.
   */
  update(event: JobEvent): boolean {
    if (event.kind === "started") {
      this.results.set(event.projectId, { jobId: event.jobId, stale: event.stale === true });
      return true;
    }

    const result = this.results.get(event.projectId);

    if (!result || result.jobId !== event.jobId) return false;

    if (event.kind === "stale" || event.stale || (event.kind === "completed" && event.exitCode !== 0)) {
      this.invalidate(event.projectId);
      return true;
    }

    if (event.kind !== "coverage" || !event.coverage || result.stale) return false;

    result.coverage = Object.fromEntries(
      Object.entries(event.coverage).map(([scene, counts]) => [scene.toLowerCase(), [...counts]]),
    );

    return true;
  }

  /**
   * Mark the current job unusable for coverage without forgetting its identity, so late events stay rejected.
   */
  invalidate(projectId: string): void {
    const result = this.results.get(projectId);

    if (result) {
      result.stale = true;
      result.coverage = undefined;
    }
  }

  /**
   * Drop removed projects when discovery replaces the project list.
   */
  retain(projectIds: string[]): void {
    const keep = new Set(projectIds);

    for (const id of this.results.keys()) if (!keep.has(id)) this.results.delete(id);
  }

  /**
   * Borrow current zero-based line counts using a case-insensitive scene key; callers must not mutate the returned array.
   */
  counts(projectId: string, scene: string): readonly number[] {
    return this.results.get(projectId)?.coverage?.[scene.toLowerCase()] ?? [];
  }
}
