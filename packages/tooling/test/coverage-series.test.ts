import { test } from "node:test";
import assert from "node:assert/strict";
import { CoverageSeries } from "../src/coverage-series.js";
import { CoverageStore, type JobEvent } from "@bifoil/choicescript-protocol";

test("compact coverage preserves counts, protocol JSON, editor iteration, and large values", () => {
  const counts = Array.from({ length: 8201 }, (_, index) => index % 17);
  counts[0] = 0x100000000;
  counts[4095] = Number.MAX_SAFE_INTEGER;
  counts[8192] = 3.5;
  const series = new CoverageSeries();
  for (const count of counts) series.push(count);
  const view = series.view();
  assert(Array.isArray(view));
  assert.deepEqual([...view], counts);
  assert.deepEqual(JSON.parse(JSON.stringify(view)), counts);
  assert.deepEqual(Object.keys(view), Object.keys(counts));
  assert.equal(view.length, counts.length);
  assert.equal(view[counts.length], undefined);
  assert.equal(counts.length in view, false);
  assert.throws(() => {
    view[0] = 1;
  }, TypeError);
  const store = new CoverageStore();
  const event: JobEvent = { protocolVersion: 1, jobId: "original", projectId: "original", kind: "started" };
  store.update(event);
  store.update({ ...event, kind: "coverage", coverage: { Startup: view } });
  assert.deepEqual(store.counts("original", "startup"), counts);
});

test("a million complete coverage rows stay below six MiB without a dense borrowed view", () => {
  const series = new CoverageSeries();
  const baseline = process.memoryUsage();
  for (let index = 0; index < 1_000_001; index++) series.push(index % 31);
  const view = series.view();
  const after = process.memoryUsage();
  assert.equal(view.length, 1_000_001);
  assert.equal(view[999_999], 999_999 % 31);
  assert(after.arrayBuffers - baseline.arrayBuffers < 6 * 1024 * 1024);
  // A dense hole-filled target costs another eight MiB even before serialization.
  assert(after.heapUsed - baseline.heapUsed < 6 * 1024 * 1024);
});
