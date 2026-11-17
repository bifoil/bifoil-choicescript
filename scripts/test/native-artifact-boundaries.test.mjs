import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyLanguageServerSource, verifyNativeArtifact } from "../native-artifact.mjs";

test("native artifact reuse rejects unknown targets after checking the real pinned source", async () => {
  const lock = await verifyLanguageServerSource();
  assert.equal(lock.format, 1);
  for (const target of ["__proto__", "constructor", "../outside", "--eval", "linux-x64/../../outside", ""]) {
    await assert.rejects(verifyNativeArtifact(target), /Unsupported native target:/);
  }
});
