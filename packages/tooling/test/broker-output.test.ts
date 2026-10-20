import { test } from "node:test";
import assert from "node:assert/strict";
import { brokerOutputChunks } from "../src/broker-output.js";
import { CoverageSeries } from "../src/coverage-series.js";

test("bounded broker coverage serializes the unchanged complete event protocol", () => {
  const expected = Array.from({ length: 13001 }, (_, index) => index % 111);
  expected[4096] = Number.MAX_SAFE_INTEGER;
  const series = new CoverageSeries();
  for (const count of expected) series.push(count);
  const event = {
    protocolVersion: 1 as const,
    projectId: "original",
    jobId: "original",
    kind: "coverage" as const,
    stale: true,
    coverage: { 'Scene Ω "': series.view(), Empty: [], Fallback: [0, 3, 2] },
  };
  const chunks = [...brokerOutputChunks({ method: "choicescript/jobEvent", params: event })];
  assert(chunks.every((chunk) => Buffer.byteLength(chunk) < 32 * 1024));
  assert.deepEqual(JSON.parse(chunks.join("")), {
    method: "choicescript/jobEvent",
    params: { ...event, coverage: { 'Scene Ω "': expected, Empty: [], Fallback: [0, 3, 2] } },
  });
});

test("million-row broker serialization has bounded transient heap", () => {
  const series = new CoverageSeries();
  for (let index = 0; index < 1_600_007; index++) series.push(index % 2);
  const baseline = process.memoryUsage().heapUsed;
  let bytes = 0,
    peak = baseline;
  for (const chunk of brokerOutputChunks({
    method: "choicescript/jobEvent",
    params: {
      protocolVersion: 1,
      projectId: "original",
      jobId: "original",
      kind: "coverage",
      coverage: { startup: series.view() },
    },
  })) {
    bytes += Buffer.byteLength(chunk);
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }
  assert(bytes > 3_200_000);
  assert(peak - baseline < 24 * 1024 * 1024, `Coverage serialization retained ${(peak - baseline) / 1048576} MiB.`);
});
