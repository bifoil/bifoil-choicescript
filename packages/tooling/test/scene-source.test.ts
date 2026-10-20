import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, openSync, writeSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { SceneSources } from "../src/scene-source.js";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "bifoil source Ω "));
  const scenes = path.join(root, "web/mygame/scenes");
  mkdirSync(scenes, { recursive: true });
  const store = new SceneSources(root);
  return {
    root,
    scenes,
    store,
    close() {
      store.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function originalLines(data: Buffer): string[] {
  const lines = data.toString("utf8").split(/\r?\n/);
  if (lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);
  return lines;
}

test("file-backed source preserves pinned headless normalization and both split modes", () => {
  const f = fixture();
  try {
    for (const [index, text] of [
      "",
      "\ufeff",
      "\ufeff\ufeffOriginal.\r\nUnicode Ω 😀.\r\r\nLast\r",
      "\r\n\r\r\n\r\r\r\n",
      'She said "Hello,\n\n"World."\n',
      "x".repeat(65535) + "😀\r\n" + "y".repeat(65537),
    ].entries()) {
      const file = path.join(f.scenes, `source${index}.txt`),
        bytes = Buffer.from(text);
      writeFileSync(file, bytes);
      const source = f.store.text(file),
        lines = originalLines(bytes),
        normalized = lines.join("\n");
      assert.equal(source.length, normalized.length);
      assert.equal(String(source), "bifoil-source:" + createHash("sha256").update(normalized).digest("hex"));
      assert.deepEqual([...source.lines()], lines);
      for (const split of ["\n", /\n/, /\r?\n/]) {
        assert.deepEqual([...source.split(split)], normalized.split(split));
        for (const limit of [0, 1, 2, 100])
          assert.deepEqual([...source.split(split, limit)], normalized.split(split, limit));
      }
    }
    const malformed = path.join(f.scenes, "invalid.txt");
    writeFileSync(malformed, Buffer.from([0xef, 0xbb, 0xbf, 0x61, 10, 0xff, 0x62]));
    const source = f.store.text(malformed);
    assert.deepEqual([...source.lines()], originalLines(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 10, 0xff, 0x62])));
    assert.throws(() => source.lines(true), /invalid\.txt line 2: invalid character/);
  } finally {
    f.close();
  }
});

test("file-backed line arrays preserve mutations, holes, descriptors and freezing", () => {
  const f = fixture();
  try {
    const file = path.join(f.scenes, "mutable.txt");
    writeFileSync(file, "one\ntwo\nthree\n");
    const actual = f.store.text(file).lines(),
      expected = ["one", "two", "three", ""];
    const same = () => {
      assert.equal(Array.isArray(actual), true);
      assert.deepEqual([...actual], [...expected]);
      assert.deepEqual(Object.keys(actual), Object.keys(expected));
      assert.deepEqual(actual.slice(), expected.slice());
    };
    same();
    actual[2] = expected[2] = "changed";
    same();
    delete actual[1];
    delete expected[1];
    same();
    actual.length = expected.length = 2;
    same();
    actual.length = expected.length = 5;
    same();
    actual[3] = expected[3] = "added";
    same();
    Object.defineProperty(actual, "0", { writable: false });
    Object.defineProperty(expected, "0", { writable: false });
    same();
    assert.deepEqual(Object.getOwnPropertyDescriptor(actual, "0"), Object.getOwnPropertyDescriptor(expected, "0"));
    Object.freeze(actual);
    Object.freeze(expected);
    same();
    assert.equal(Object.isFrozen(actual), true);
  } finally {
    f.close();
  }
});

test("source captures are immutable and disposal removes only owned cache files", () => {
  const f = fixture();
  try {
    const file = path.join(f.scenes, "snapshot.txt");
    writeFileSync(file, "Original Ω.\n");
    const old = f.store.text(file);
    writeFileSync(file, "Revised 😀 source.\n");
    const next = f.store.text(file);
    assert.deepEqual([...old.lines()], ["Original Ω.", ""]);
    assert.deepEqual([...next.lines()], ["Revised 😀 source.", ""]);
    assert.notEqual(String(old), String(next));
    assert.throws(() => f.store.text(path.join(f.root, "outside.txt")), /outside/);
    f.store.dispose();
    f.store.dispose();
    assert.deepEqual(readdirSync(f.scenes), ["snapshot.txt"]);
    assert.equal(
      readdirSync(f.root).some((name) => name.startsWith(".bifoil-source-")),
      false,
    );
  } finally {
    f.close();
  }
});

test("million-row source view does not allocate a dense line array", () => {
  const f = fixture();
  try {
    const file = path.join(f.scenes, "large.txt"),
      fd = openSync(file, "wx"),
      chunk = Buffer.from("Original scene row.\n".repeat(1000));
    try {
      for (let i = 0; i < 1000; i++) writeSync(fd, chunk);
    } finally {
      closeSync(fd);
    }
    const source = f.store.text(file),
      before = process.memoryUsage().heapUsed,
      lines = source.lines();
    assert.equal(lines.length, 1000001);
    assert.equal(lines[999999], "Original scene row.");
    assert.equal(lines[1000000], "");
    assert.deepEqual(lines.slice(999997, 1000000), Array(3).fill("Original scene row."));
    assert.ok(
      process.memoryUsage().heapUsed - before < 4 * 1024 * 1024,
      "source view allocated a million-element dense backing array",
    );
  } finally {
    f.close();
  }
});

test("hot pages and repeated rows preserve snapshot identity and CR split modes", () => {
  const f = fixture();
  try {
    const file = path.join(f.scenes, "boundaries.txt");
    const captures = ["Ω", "😀", "revised"].map((prefix) => {
      const text = Array.from({ length: 12000 }, (_, line) => `${prefix} ${line} ${"x".repeat(90)}\r`).join("\r\n");
      writeFileSync(file, text);
      const source = f.store.text(file);
      const normalized = originalLines(Buffer.from(text)).join("\n");
      return { plain: source.split("\n"), split: source.split(/\r?\n/), expected: normalized.split("\n") };
    });
    for (const line of [0, 1, 620, 8191, 8192, 11999, 620, 0]) {
      for (const capture of captures) {
        assert.equal(capture.plain[line], capture.expected[line]);
        assert.equal(capture.plain[line], capture.expected[line]);
        const expected = capture.expected[line];
        assert.equal(capture.split[line], line < 11999 ? expected.slice(0, -1) : expected);
        assert.equal(capture.plain[line], expected);
      }
    }
  } finally {
    f.close();
  }
});
