import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyLanguageServerSource, verifyNativeArtifact, stageNativeArtifacts } from "../native-artifact.mjs";

test("native artifact reuse rejects unknown targets after checking the real pinned source", async () => {
  const lock = await verifyLanguageServerSource();
  assert.equal(lock.format, 1);
  for (const target of ["__proto__", "constructor", "../outside", "--eval", "linux-x64/../../outside", ""]) {
    await assert.rejects(verifyNativeArtifact(target), /Unsupported native target:/);
  }
});

test("native staging drains failed parallel copies before removing its owned staging tree", async (t) => {
  const target = `${process.platform}-${process.arch}`;
  const { manifest } = await verifyNativeArtifact(target);
  const bundle = await mkdtemp(path.join(tmpdir(), "bifoil-native-stage-contract-"));
  t.after(() => rm(bundle, { recursive: true, force: true }));
  await mkdir(path.join(bundle, "native"));
  const retained = path.join(bundle, "native/original.txt");
  await writeFile(retained, "Original retained native tree");
  await assert.rejects(stageNativeArtifacts(bundle, [target, target]), { code: "EEXIST" });
  assert.equal(await readFile(retained, "utf8"), "Original retained native tree");
  assert.deepEqual(await readdir(bundle), ["native"]);

  await stageNativeArtifacts(bundle, [target]);
  const names = await readdir(path.join(bundle, "native", target));
  assert.deepEqual(names.sort(), [manifest.executable, "manifest.json", "GO_LICENSE.txt"].sort());
  const copied = JSON.parse(await readFile(path.join(bundle, "native", target, "manifest.json"), "utf8"));
  assert.equal(copied.sha256, manifest.sha256);
  assert.deepEqual(await readdir(bundle), ["native"]);
});
