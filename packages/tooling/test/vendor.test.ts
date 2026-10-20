import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const engine = path.join(root, "vendor/choicescript");

test("engine verification handles submodule metadata, modified files, revision mismatches, and missing initialization", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bifoil-choicescript submodule Ω "));

  try {
    const vendor = path.join(directory, "vendor");
    const checkout = path.join(vendor, "choicescript");
    await mkdir(vendor);
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", engine, checkout]);
    execFileSync("git", ["-C", checkout, "config", "core.autocrlf", "false"]);
    execFileSync("git", ["-C", checkout, "checkout", "--quiet", "--detach", "HEAD"]);
    for (const file of ["choicescript.lock.json", "checksums.json"])
      await cp(path.join(root, "vendor", file), path.join(vendor, file));

    for (const script of ["check-engine.mjs", "host-tools.mjs"])
      await cp(path.join(root, "scripts", script), path.join(directory, script));

    const check = (...args: string[]) =>
      execFileSync(process.execPath, ["check-engine.mjs", ...args], {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

    assert.match(check(), /Verified ChoiceScript submodule/);

    check("--record");

    const expected = JSON.parse(await readFile(path.join(root, "vendor/checksums.json"), "utf8"));

    assert.deepEqual(JSON.parse(await readFile(path.join(vendor, "checksums.json"), "utf8")), expected);

    const source = path.join(checkout, "quicktest.js");
    const original = await readFile(source);
    await writeFile(source, "Modified engine file");

    assert.throws(() => check(), /ChoiceScript files differ from the pinned snapshot/);

    await writeFile(source, original);

    const lockFile = path.join(vendor, "choicescript.lock.json");
    const lock = await readFile(lockFile, "utf8");
    await writeFile(lockFile, JSON.stringify({ ...JSON.parse(lock), commit: "0".repeat(40) }));

    assert.throws(() => check(), /expected 0{40}/);

    await writeFile(lockFile, lock);

    await rm(path.join(checkout, ".git"), { recursive: true });

    assert.throws(() => check(), /submodule is not initialized.*submodule update --init --recursive/);

    await rm(checkout, { recursive: true });

    assert.throws(() => check(), /submodule is not initialized.*submodule update --init --recursive/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled engines retain the selected pinned runtime bytes and exclude development files", async () => {
  const checksums = JSON.parse(await readFile(path.join(root, "vendor/checksums.json"), "utf8"));
  const inventory = JSON.parse(await readFile(path.join(root, "vendor/runtime-files.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(root, "vendor/choicescript.lock.json"), "utf8"));

  assert.equal(inventory.engineCommit, lock.commit);
  assert(inventory.files.includes("LICENSE.txt"));
  assert(inventory.files.includes("editor/embeddable-autotester.js"));
  assert(!inventory.files.includes("js.jar"));

  const expected = Object.fromEntries(inventory.files.map((file: string) => [file, checksums[file]]));

  for (const relative of ["dist/server/vendor/choicescript", "editors/vscode/server/vendor/choicescript"]) {
    const directory = path.join(root, relative);
    const actual: Record<string, string> = {};

    async function walk(folder: string) {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        assert.notEqual(entry.name, ".git", "Git metadata must not ship in plugins");

        const file = path.join(folder, entry.name);

        if (entry.isDirectory()) await walk(file);
        else
          actual[path.relative(directory, file).split(path.sep).join("/")] = createHash("sha256")
            .update(await readFile(file))
            .digest("hex");
      }
    }

    await walk(directory);

    assert.deepEqual(actual, expected, relative);
  }
});
