export const PROTOCOL_VERSION = 1;
export type Operation = "createProject" | "run" | "stop" | "quicktest" | "randomtest" | "exportHtml";
export interface Project {
  id: string;
  root: string;
  sceneDir: string;
  assetDir: string;
  name: string;
  randomtest?: { iterations?: number; seed?: number };
}
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
export interface JobResult {
  jobId: string;
  projectId: string;
  url?: string;
  output?: string;
}
export interface BufferSnapshot {
  uri: string;
  text: string;
  version: number;
}
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
export interface IndexStatus {
  projectId: string;
  scenes: number;
  indexed: number;
  words: number;
  failures: number;
  complete: boolean;
  limited: boolean;
}
