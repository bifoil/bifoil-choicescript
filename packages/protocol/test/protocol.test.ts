import { test } from "node:test";
import assert from "node:assert/strict";
import { CoverageStore, type JobEvent, parseIterations, parseSeed, validSeed } from "@bifoil/choicescript-protocol";

test("RandomTest accepts the same integer boundaries as its editor inputs", () => {
  for (const seed of [Number.MIN_SAFE_INTEGER, -2_147_483_649, 0, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
    assert.equal(parseSeed(String(seed)), seed);
    assert(validSeed(seed));
  }

  for (const seed of ["", " ", "1.5", "1e3", "Infinity", "NaN", "9007199254740992", "-9007199254740992"]) {
    assert.equal(parseSeed(seed), undefined, seed);
  }

  assert.equal(parseIterations("1"), 1);
  assert.equal(parseIterations("10000000"), 10_000_000);

  for (const count of ["0", "10000001", "-1", "1.5", "", "1e3"]) assert.equal(parseIterations(count), undefined);
});

test("coverage stays with its game and latest run and cannot return after an edit", () => {
  const store = new CoverageStore();

  const event = (projectId: string, jobId: string, kind: JobEvent["kind"], extra: Partial<JobEvent> = {}) =>
    store.update({ protocolVersion: 1, projectId, jobId, kind, ...extra });

  event("one", "old", "started");
  event("one", "old", "coverage", { coverage: { startup: [1, 0, 2] } });
  event("two", "other", "started");
  event("two", "other", "coverage", { coverage: { startup: [0, 3] } });

  assert.deepEqual(store.counts("one", "STARTUP"), [1, 0, 2]);
  assert.deepEqual(store.counts("two", "startup"), [0, 3]);

  event("one", "new", "started");
  event("one", "new", "coverage", { coverage: { startup: [4] } });
  event("one", "old", "stale");
  event("one", "old", "coverage", { coverage: { startup: [99] } });

  assert.deepEqual(store.counts("one", "startup"), [4]);

  store.invalidate("one");
  event("one", "new", "coverage", { coverage: { startup: [99] } });

  assert.deepEqual(store.counts("one", "startup"), []);
  assert.deepEqual(store.counts("two", "startup"), [0, 3]);

  event("one", "stale-start", "started", { stale: true });
  event("one", "stale-start", "coverage", { coverage: { startup: [99] } });

  assert.deepEqual(store.counts("one", "startup"), []);

  event("two", "other", "completed", { exitCode: 130 });

  assert.deepEqual(store.counts("two", "startup"), []);

  store.retain([]);
  event("one", "stale-start", "coverage", { coverage: { startup: [99] } });

  assert.deepEqual(store.counts("one", "startup"), []);
});

test("RandomTest seed range remains exact across the requested iterations", async () => {
  const { validSeedRange } = await import("@bifoil/choicescript-protocol");

  assert(validSeedRange(Number.MAX_SAFE_INTEGER, 1));
  assert(!validSeedRange(Number.MAX_SAFE_INTEGER, 2));
  assert(validSeedRange(Number.MAX_SAFE_INTEGER - 1, 2));
  assert(validSeedRange(Number.MIN_SAFE_INTEGER, 10_000_000));
});
