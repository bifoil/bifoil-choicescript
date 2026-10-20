import { test } from "node:test";
import assert from "node:assert/strict";
import { Environment } from "../src/environment.js";
import { literal, unknown } from "../src/types.js";

// Exercise source-like declaration, reassignment and scope removal while older
// flow states remain live. The plain maps are independent snapshot oracles.
test("persistent flow environments retain older states through updates and removals", () => {
  let environment = new Environment();
  let expected = new Map<string, ReturnType<typeof literal>>();
  const snapshots: [Environment, typeof expected][] = [];

  for (let step = 0; step < 4000; step++) {
    const key = "variable_" + ((step * 7919) % 997);
    if (step % 13 === 0) {
      snapshots.push([environment.clone(), new Map(expected)]);
      environment = environment.clone();
    }
    if (step % 5 === 0) {
      environment.delete(key);
      expected.delete(key);
    } else {
      const value = literal(step % 3 ? step : "text");
      environment.set(key, value);
      expected.set(key, value);
    }
    assert.equal(environment.size, expected.size);
    assert.deepEqual(environment.get(key), expected.get(key));
  }

  for (const [snapshot, values] of [...snapshots, [environment, expected]] as typeof snapshots) {
    assert.deepEqual(new Map(snapshot), values);
    assert.deepEqual([...snapshot.keys()].sort(), [...values.keys()].sort());
  }
});

test("branch joins preserve independent declarations, removed bindings and mixed types", () => {
  const entry = new Environment(
    new Map([
      ["score", literal(10)],
      ["name", literal("Alex")],
      ["flag", literal(true)],
    ]),
  );
  const left = entry.clone(),
    right = entry.clone();
  left.set("score", literal("ten"));
  left.set("left_only", literal(false));
  right.delete("name");
  right.set("right_only", literal(3));
  const joined = left.join(right);

  assert.deepEqual(joined.get("score")?.types, ["number", "string"]);
  assert.equal(joined.get("score")?.constant, undefined);
  assert.deepEqual(joined.get("name")?.types, ["string", "unknown"]);
  assert.deepEqual(joined.get("left_only")?.types, ["boolean", "unknown"]);
  assert.deepEqual(joined.get("right_only")?.types, ["number", "unknown"]);
  assert.equal(joined.get("flag")?.constant, true);
  assert.equal(entry.get("score")?.constant, 10);
  assert.equal(entry.get("name")?.constant, "Alex");
  assert(joined.equals(right.join(left)));
  assert(joined.equals(joined.join(left)));

  const untouched = entry.clone();
  untouched.set("score", literal(10));
  untouched.delete("absent");
  assert(untouched.shares(entry));
  assert(entry.equals(new Environment([...entry].reverse())));
  assert(!entry.equals(new Environment([["score", unknown()]])));

  for (const key of joined.keys()) joined.delete(key);
  assert.equal(joined.size, 0);
  assert.equal(entry.size, 3);
});

test("environment prefix deletion and empty forks preserve independent snapshots", () => {
  const entries: [string, ReturnType<typeof literal>][] = [
    ["scene_a", literal(1)], ["scene_a_1", literal("first")], ["scene_b", literal(true)],
    ["scene_😀", literal("Unicode")], ["other", literal(7)],
  ];
  const environment = new Environment(entries), snapshot = environment.clone();
  assert.deepEqual(new Map(environment.entriesWithPrefix("scene_a")), new Map(entries.slice(0, 2)));
  environment.deletePrefix("scene_a");
  assert.deepEqual(new Map(environment), new Map(entries.slice(2)));
  assert.deepEqual(new Map(snapshot), new Map(entries));
  assert.equal(environment.has("scene_a"), false);
  assert.equal(environment.has("other"), true);
  assert.equal(environment.empty().size, 0);
  assert(!environment.shares(snapshot));
  environment.deletePrefix("scene_");
  assert.deepEqual([...environment.keys()], ["other"]);
  environment.deletePrefix("");
  assert.equal(environment.size, 0);
  assert(environment.equals(new Environment()));
});
