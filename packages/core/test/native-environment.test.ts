import { test } from "node:test";
import assert from "node:assert/strict";
import { Environment } from "../src/environment.js";
import { NativeEnvironmentArena } from "../src/native-environment.js";
import { literal, unknown } from "../src/types.js";

// A plain Map is an independent ownership/lifetime oracle. Keep old snapshots
// live through enough updates to exercise arena reclamation repeatedly.
test("compiled environments retain snapshots through bounded arena collection", () => {
  const arena = new NativeEnvironmentArena();
  let current = arena.environment();
  const expected = new Map<string, ReturnType<typeof literal>>();
  const saved: [Environment, typeof expected][] = [];
  let collections = 0;
  for (let step = 0; step < 45000; step++) {
    if (step % 7500 === 0) saved.push([current.clone(), new Map(expected)]);
    const key = "value_" + ((step * 7919) % 997);
    if (step % 7 === 0) {
      current.delete(key);
      expected.delete(key);
    } else {
      const value = literal(step % 3 ? step : "text");
      current.set(key, value);
      expected.set(key, value);
    }
    if (arena.needsCollection) {
      arena.collect([current, ...saved.map(([environment]) => environment)]);
      collections++;
    }
    assert.equal(current.size, expected.size);
    assert.deepEqual(current.get(key), expected.get(key));
  }
  assert(collections > 0);
  for (const [environment, values] of [...saved, [current, expected]] as typeof saved)
    assert.deepEqual(new Map(environment), values);
  assert(arena.committedBytes < 48 * 1024 * 1024);
});

test("compiled joins agree with the reference domain across missing bindings and storage depths", () => {
  const arena = new NativeEnvironmentArena();
  const left = arena.environment(),
    right = arena.environment();
  const referenceLeft = new Environment(),
    referenceRight = new Environment();
  for (let i = 0; i < 5000; i++) {
    const key = "binding_" + i;
    if (i % 5) {
      const value = i % 3 ? literal(i) : unknown();
      left.set(key, value);
      referenceLeft.set(key, value);
    }
    if (i % 7) {
      const value = i % 4 ? literal(i) : literal("text");
      right.set(key, value);
      referenceRight.set(key, value);
    }
  }
  const actual = left.join(right),
    expected = referenceLeft.join(referenceRight);
  assert(actual.equals(expected));
  assert(expected.equals(actual));
  assert(actual.equals(right.join(left)));
  assert(actual.equals(actual.join(left)));
  const snapshot = new Map(left);
  for (const key of left.keys()) left.delete(key);
  assert.equal(left.size, 0);
  assert.equal(snapshot.size, referenceLeft.size);
  const outer = [...right].slice(0, 3);
  for (const [key, value] of outer) {
    assert.deepEqual(right.get(key), value);
    assert.deepEqual(new Map(actual), new Map(expected));
  }
  arena.collect([actual, right]);
  assert(actual.equals(expected));
});

test("mixed environment storage preserves joins, prefix operations and arena reset", () => {
  const arena = new NativeEnvironmentArena(), foreign = new NativeEnvironmentArena();
  const values: [string, ReturnType<typeof literal>][] = [["scope_a", literal(1)], ["scope_b", literal("two")], ["other", literal(false)]];
  const native = arena.environment(values), reference = new Environment(values);
  assert(native.equals(reference)); assert(reference.equals(native));
  assert(!native.shares(reference)); assert(!reference.shares(native));
  assert(!native.shares(foreign.environment(values)));
  assert(native.shares(native.clone()));
  assert.equal(native.empty().size, 0);
  const different = arena.environment([["other", literal(true)], ["additional", literal(3)]]);
  assert(!reference.equals(different)); assert(!different.equals(reference));
  const nativeJoin = native.join(different), referenceJoin = reference.join(different);
  assert.deepEqual(new Map(nativeJoin), new Map(referenceJoin));
  assert.deepEqual(new Map(native.entriesWithPrefix("scope_")), new Map(values.slice(0, 2)));
  native.deletePrefix("scope_");
  assert.deepEqual(new Map(native), new Map(values.slice(2)));
  assert.equal(reference.size, 3);
  const copy = foreign.environment(values);
  assert(nativeJoin.join(copy).equals(referenceJoin.join(copy)));
  assert.throws(() => native.set("invalid", { types: [] }), /at least one type/);
  arena.collect([native, reference, copy]);
  arena.reset();
  const fresh = arena.environment([["fresh", literal("reset")]]);
  assert.deepEqual([...fresh], [["fresh", literal("reset")]]);
});
