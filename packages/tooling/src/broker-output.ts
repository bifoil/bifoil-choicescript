/** Bound private transport writes, including complete million-row coverage. */
import type { JobEvent } from "@bifoil/choicescript-protocol";
import { coverageJSONChunks } from "./coverage-series.js";

export type BrokerOutput =
  | { method: "choicescript/jobEvent"; params: JobEvent }
  | { id: number | null; result?: unknown; error?: { code: number; message: string } };

/** Each chunk forms part of one ordered JSON line; no game-sized JSON string is built. */
export function* brokerOutputChunks(message: BrokerOutput): Generator<string> {
  if (!("method" in message) || message.params.kind !== "coverage" || !message.params.coverage) {
    yield JSON.stringify(message) + "\n";
    return;
  }
  const { coverage, ...metadata } = message.params;
  yield '{"method":"choicescript/jobEvent","params":' + JSON.stringify(metadata).slice(0, -1) + ',"coverage":{';
  let first = true;
  for (const [scene, counts] of Object.entries(coverage)) {
    yield (first ? "" : ",") + JSON.stringify(scene) + ":";
    first = false;
    yield* coverageJSONChunks(counts);
  }
  yield "}}}\n";
}
