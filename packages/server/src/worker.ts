import { parentPort } from "node:worker_threads";
import { analyzeProject } from "@branchlight/core";

parentPort!.on("message", ({ documents, options }) => {
  try {
    parentPort!.postMessage({ analysis: analyzeProject(documents, options) });
  } catch (error) {
    parentPort!.postMessage({ error: String(error) });
  }
});
