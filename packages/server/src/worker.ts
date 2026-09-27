import { parentPort } from "node:worker_threads";
import { analyzeProject } from "../../core/src/index.js";
parentPort!.on("message", ({ documents, options }) => {
  try {
    parentPort!.postMessage({ analysis: analyzeProject(documents, options) });
  } catch (error) {
    parentPort!.postMessage({ error: String(error) });
  }
});
