/**
 * Version of the custom choicescript/* job contract, independent of the LSP version.
 * Keep Kotlin DTOs and both adapters aligned when changing request/event semantics.
 * See docs/protocol.md for ordering, cancellation, and completion rules.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Game-tool operation names on the wire; these are not the editor's action identifiers.
 */
export type Operation = "createProject" | "run" | "stop" | "quicktest" | "randomtest" | "exportHtml";

/**
 * Detected game descriptor. id is opaque to clients (currently the scene-directory URI).
 * root, sceneDir and assetDir are absolute server-host paths, not document URIs.
 * randomtest values are defaults; explicit request options take precedence.
 */
export interface Project {
  id: string;
  root: string;
  sceneDir: string;
  assetDir: string;
  name: string;
  randomtest?: { iterations?: number; seed?: number };
}

/**
 * Parameters for choicescript/job and the first workspace/executeCommand argument.
 * Creation/export need destination; ordinary starts need a discovered projectId.
 * A fresh UUID jobId lets clients stop preparation before the start response arrives.
 * Stop can select a job, a project, or all owned jobs when both selectors are absent.
 * trusted conveys the editor's trust decision; it is not authentication for a network API.
 */
export interface JobRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  operation: Operation;
  projectId?: string;
  destination?: string;
  iterations?: number;
  seed?: number;
  showText?: boolean;
  jobId?: string;
  trusted?: boolean;
}

/**
 * Asynchronous lifecycle/output notification; subscribe before sending the start request.
 * Correlate by jobId because notifications can precede its JobResult. line and coverage
 * array indices are zero-based source lines; uri is a file URI. Output may be chunked.
 * Completion codes: 0 success, 130 cancellation, other nonzero failure. Stale events
 * still describe the captured snapshot and must not become current diagnostics.
 */
export interface JobEvent {
  protocolVersion: typeof PROTOCOL_VERSION;
  jobId: string;
  projectId: string;
  kind: "started" | "output" | "diagnostic" | "coverage" | "preview" | "completed" | "stale";
  message?: string;
  uri?: string;
  line?: number;
  severity?: 1 | 2;
  url?: string;
  exitCode?: number;
  coverage?: Record<string, number[]>;
  stale?: boolean;
}

/**
 * Operation handle, not a test-success result. Test/export starts acknowledge after
 * preparation/launch; completion arrives through JobEvent. output is the saved log path.
 * Preview supplies url. Creation completes directly with the sentinel jobId "created".
 */
export interface JobResult {
  jobId: string;
  projectId: string;
  url?: string;
  output?: string;
}

/**
 * Immutable-by-convention open-document capture: file URI, exact text, and editor version at job/analysis capture.
 */
export interface BufferSnapshot {
  uri: string;
  text: string;
  version: number;
}

/**
 * LSP executeCommand names; the same JobRequest contract also travels through choicescript/job.
 */
export const commands = [
  "bifoil.choicescript.server.createProject",
  "bifoil.choicescript.server.run",
  "bifoil.choicescript.server.stop",
  "bifoil.choicescript.server.quicktest",
  "bifoil.choicescript.server.randomtest",
  "bifoil.choicescript.server.exportHtml",
];

export * from "./options.js";
export { CoverageStore } from "./coverage.js";

export * from "./runtime.js";

/**
 * Read-only status returned by choicescript/indexStatus.
 * indexed counts cached scenes, not completed flow analysis; use complete for readiness.
 * words can be partial. failures counts recorded per-file failures, not every worker crash.
 * limited indicates an exhausted analysis budget, which cannot establish full acceptance.
 */
export interface IndexStatus {
  projectId: string;
  scenes: number;
  indexed: number;
  words: number;
  failures: number;
  complete: boolean;
  limited: boolean;
}
