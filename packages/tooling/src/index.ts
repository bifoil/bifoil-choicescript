/**
 * Local project discovery and trusted game-job APIs. Callers own editor trust decisions,
 * subscribe before starting jobs, and await ToolRunner.dispose() at shutdown.
 */
export * from "./projects.js";
export * from "./runner.js";
