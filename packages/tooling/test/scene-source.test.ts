import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, openSync, writeSync, closeSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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

test("virtual scene arrays preserve sparse descriptor and exotic-key behavior", () => {
  const f = fixture();
  try {
    const file = path.join(f.scenes, "original-boundaries.txt");
    writeFileSync(file, "first\nsecond\nthird");
    const actual = f.store.text(file).lines();
    const expected = ["first", "second", "third"];
    const marker = Symbol("original metadata");
    const compare = () => {
      assert.deepEqual(Reflect.ownKeys(actual), Reflect.ownKeys(expected));
      for (const key of ["0", "1", "2", "-1", "01", "4294967295", "length", marker]) {
        assert.deepEqual(
          Reflect.getOwnPropertyDescriptor(actual, key),
          Reflect.getOwnPropertyDescriptor(expected, key),
        );
        assert.equal(Reflect.has(actual, key), Reflect.has(expected, key));
      }
    };
    for (const array of [actual, expected]) {
      Reflect.set(array, marker, "metadata");
      Reflect.set(array, "01", "not an index");
      Reflect.set(array, "4294967295", "not an array index");
      Reflect.defineProperty(array, "0", { writable: false });
      Reflect.deleteProperty(array, "2");
      Reflect.deleteProperty(array, marker);
      array.length = 1;
      array.length = 3;
      Reflect.defineProperty(array, "length", { value: 2 });
    }
    compare();
    assert.equal(Reflect.set(actual, "0", "cannot replace"), false);
    assert.equal(actual[0], "first");
    Object.preventExtensions(actual);
    Object.preventExtensions(expected);
    compare();
    assert.equal(Reflect.defineProperty(actual, "5", { value: "outside" }), false);
  } finally {
    f.close();
  }
});

test("scene metadata and split adapters reject unsupported operations and retain lazy match input", () => {
  const f = fixture();
  try {
    const file = path.join(f.scenes, "original-metadata.txt");
    writeFileSync(file, "*title Original Ω\n*author Chinay\nOriginal last line.");
    const text = f.store.text(file);
    for (const separator of ["", ",", /./]) assert.throws(() => text.split(separator), /Unsupported source split/);
    for (const expression of [/title/, /^\*title (.*)/gm])
      assert.throws(() => text.metadataMatch(expression, RegExp.prototype.exec), /Unsupported direct source/);
    const match = text.metadataMatch(/^\*title (.*)/m, RegExp.prototype.exec)!;
    assert.equal(match[1], "Original Ω");
    assert.equal(match.input, "*title Original Ω\n*author Chinay\nOriginal last line.");
    match.input = "explicit replacement";
    assert.equal(match.input, "explicit replacement");
    assert.equal(text.metadataMatch(/^\*author /m, RegExp.prototype.exec)!.index, "*title Original Ω\n".length);
    const missing = path.join(f.scenes, "missing-metadata.txt");
    writeFileSync(missing, "Original prose only.");
    assert.equal(f.store.text(missing).metadataMatch(/^\*title (.*)/m, RegExp.prototype.exec), null);
    assert.deepEqual([...text.lines(true)], ["*title Original Ω", "*author Chinay", "Original last line."]);
    f.store.dispose();
    assert.throws(() => f.store.text(file), /storage is closed/);
    assert.throws(() => text.lines()[0], /storage is closed/);
  } finally {
    f.close();
  }
});

test("source capture reuses unchanged identities and refuses staged directories", () => {
  const f = fixture();
  try {
    const file = path.join(f.scenes, "reused.txt");
    writeFileSync(file, "Original snapshot.\n");
    const first = f.store.text(file);
    const owned = () => readdirSync(f.root).filter((name) => name.startsWith(".bifoil-source-"));
    const cache = path.join(f.root, owned()[0]);
    const files = readdirSync(cache);
    const second = f.store.text(file);
    assert.equal(String(second), String(first));
    assert.deepEqual([...second.lines()], ["Original snapshot.", ""]);
    assert.deepEqual(readdirSync(cache), files);
    const directory = path.join(f.scenes, "directory.txt");
    mkdirSync(directory);
    assert.throws(() => f.store.text(directory), /regular staged file/);
    assert.ok(fs.statSync(directory).isDirectory());
  } finally {
    f.close();
  }
});

test("truncated owned snapshots fail without reading the mutable staged source", () => {
  const f = fixture();
  try {
    const file = path.join(f.scenes, "immutable.txt");
    writeFileSync(file, "Original immutable row.\n");
    const text = f.store.text(file);
    const cache = path.join(f.root, readdirSync(f.root).find((name) => name.startsWith(".bifoil-source-"))!);
    const source = readdirSync(cache).find((name) => name.endsWith(".source"))!;
    fs.truncateSync(path.join(cache, source), 0);
    writeFileSync(file, "Changed staged row must not be substituted.\n");
    assert.throws(() => text.lines()[0], /Incomplete immutable tool source storage/);
    assert.equal(fs.readFileSync(file, "utf8"), "Changed staged row must not be substituted.\n");
  } finally {
    f.close();
  }
});

test("capture rejects incomplete writes and removes its partial owned outputs", (t) => {
  const f = fixture();
  const write = fs.writeSync;
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.close();
  });
  const file = path.join(f.scenes, "write-failure.txt");
  writeFileSync(file, "Original snapshot.\n");
  t.mock.method(fs, "writeSync", () => 0);
  syncBuiltinESMExports();
  assert.throws(() => f.store.text(file), /Could not preserve a complete tool source snapshot/);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  const cache = path.join(f.root, readdirSync(f.root).find((name) => name.startsWith(".bifoil-source-"))!);
  assert.deepEqual(readdirSync(cache), []);
  assert.equal(fs.writeSync, write);
  assert.deepEqual([...f.store.text(file).lines()], ["Original snapshot.", ""]);
});

test("capture rejects each changed file identity and retains the caller's source", (t) => {
  const f = fixture();
  const stat = fs.fstatSync;
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.close();
  });
  const file = path.join(f.scenes, "identity-failure.txt");
  writeFileSync(file, "Original snapshot.\n");
  for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const) {
    t.mock.method(fs, "fstatSync", (fd: number) => {
      const observed = stat(fd, { bigint: true });
      return { ...observed, [field]: observed[field] + 1n };
    });
    syncBuiltinESMExports();
    assert.throws(() => f.store.text(file), /Staged scene changed while capturing/);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    const cache = path.join(f.root, readdirSync(f.root).find((name) => name.startsWith(".bifoil-source-"))!);
    assert.deepEqual(readdirSync(cache), []);
    assert.equal(fs.readFileSync(file, "utf8"), "Original snapshot.\n");
  }
  assert.deepEqual([...f.store.text(file).lines()], ["Original snapshot.", ""]);
});

test("safe-offset and short-read refusals leave no accepted capture", (t) => {
  const f = fixture();
  const stat = fs.lstatSync;
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.close();
  });
  const file = path.join(f.scenes, "short-read.txt");
  writeFileSync(file, "Original snapshot.\n");
  t.mock.method(fs, "lstatSync", () => {
    const observed = stat(file, { bigint: true });
    observed.size = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    return observed;
  });
  syncBuiltinESMExports();
  assert.throws(() => f.store.text(file), /safe file-offset precision/);
  t.mock.restoreAll();
  t.mock.method(fs, "readSync", () => 0);
  syncBuiltinESMExports();
  assert.throws(() => f.store.text(file), /Staged scene changed while capturing/);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  const cache = path.join(f.root, readdirSync(f.root).find((name) => name.startsWith(".bifoil-source-"))!);
  assert.deepEqual(readdirSync(cache), []);
  assert.deepEqual([...f.store.text(file).lines()], ["Original snapshot.", ""]);
});

test("failed exclusive output opens close the captured input and preserve the failure", (t) => {
  const f = fixture();
  const open = fs.openSync;
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.close();
  });
  const file = path.join(f.scenes, "open-failure.txt");
  writeFileSync(file, "Original snapshot.\n");
  for (const suffix of [".source", ".offsets"]) {
    const failure = new Error(`Owned ${suffix} output could not be opened`);
    let input: number | undefined;
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).endsWith(suffix)) throw failure;
      const fd = open(...args);
      if (args[0] === file) input = fd;
      return fd;
    });
    syncBuiltinESMExports();
    assert.throws(
      () => f.store.text(file),
      (error) => error === failure,
    );
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.notEqual(input, undefined);
    assert.throws(() => fs.fstatSync(input!), { code: "EBADF" });
    const cache = path.join(f.root, readdirSync(f.root).find((name) => name.startsWith(".bifoil-source-"))!);
    assert.deepEqual(readdirSync(cache), []);
  }
  assert.deepEqual([...f.store.text(file).lines()], ["Original snapshot.", ""]);
});

test("source caches evict old descriptors and decline retaining a giant decoded line", () => {
  const f = fixture();
  try {
    const views = [];
    for (let index = 0; index < 20; index++) {
      const file = path.join(f.scenes, `scene${index}.txt`);
      writeFileSync(file, `Original row ${index}.\n`);
      views.push(f.store.text(file).lines());
    }
    for (let index = 0; index < views.length; index++) assert.equal(views[index][0], `Original row ${index}.`);
    for (let index = views.length - 1; index >= 0; index--) assert.equal(views[index][0], `Original row ${index}.`);
    const file = path.join(f.scenes, "giant-line.txt");
    const line = "Ω".repeat(1024 * 1024 + 1);
    writeFileSync(file, line);
    const lines = f.store.text(file).lines();
    assert.equal(lines[0], line);
    assert.equal(lines[0], line);
    assert.deepEqual(
      readdirSync(f.scenes).sort(),
      [...Array.from({ length: 20 }, (_, i) => `scene${i}.txt`), "giant-line.txt"].sort(),
    );
  } finally {
    f.close();
  }
});

test("shrinking lazy line arrays preserves deleted rows below the new length", () => {
  const f = fixture();
  try {
    const file = path.join(f.scenes, "retained-hole.txt");
    writeFileSync(file, "first\nsecond\nthird");
    const actual = f.store.text(file).lines();
    const expected = ["first", "second", "third"];
    for (const lines of [actual, expected]) {
      delete lines[0];
      lines.length = 2;
      lines.length = 3;
    }
    Object.preventExtensions(actual);
    Object.preventExtensions(expected);
    assert.deepEqual([...actual], [...expected]);
    assert.deepEqual(Reflect.ownKeys(actual), Reflect.ownKeys(expected));
    assert.equal(0 in actual, false);
    assert.equal(actual[1], "second");
    assert.equal(2 in actual, false);
  } finally {
    f.close();
  }
});

test("source checksum callbacks receive normalized immutable text and the caller's initial seed", () => {
  const f = fixture();
  try {
    const file = path.join(f.scenes, "checksum.txt");
    const raw = "\ufeffOriginal Ω.\r\nSecond 😀 row.\r\n";
    writeFileSync(file, raw);
    const text = f.store.text(file);
    const checksum = (value: string, prior = 0) => {
      let result = prior;
      for (const character of value) result = (result * 31 + character.codePointAt(0)!) >>> 0;
      return result;
    };
    const normalized = originalLines(Buffer.from(raw)).join("\n");
    writeFileSync(file, "Revised source must not change the captured checksum.");
    assert.equal(text.crc32(checksum), checksum(normalized));
    assert.equal(text.crc32(checksum, 19), checksum(normalized, 19));
    assert.notEqual(text.crc32(checksum, 19), checksum(normalized));
  } finally {
    f.close();
  }
});
