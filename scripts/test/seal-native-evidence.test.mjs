import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openEvidence, sealEvidence, sealDirectory } from "../seal-native-evidence.mjs";

const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const { publicKey, privateKey } = pair();

test("private native evidence round-trips only for its recipient and authenticates ciphertext", () => {
  const files = { "conditions.json": "Private original source observation", "go.out": "Private original counters" };
  const sealed = sealEvidence(files, publicKey);
  assert(!sealed.includes("Private original"));
  assert(!sealed.includes("conditions.json"));
  assert.deepEqual(openEvidence(sealed, privateKey), files);
  assert.throws(() => openEvidence(sealed, pair().privateKey));
  const changed = JSON.parse(sealed);
  const body = Buffer.from(changed.body, "base64");
  body[0] ^= 1;
  changed.body = body.toString("base64");
  assert.throws(() => openEvidence(JSON.stringify(changed), privateKey));
  assert.throws(() => openEvidence(JSON.stringify({ ...changed, format: "unsupported" }), privateKey), /Unsupported/);
});

test("the evidence CLI seals regular reports and logs, and refuses an empty evidence directory", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bifoil private evidence "));
  try {
    const inputs = path.join(directory, "inputs");
    await mkdir(inputs);
    await mkdir(path.join(inputs, "directory.json"));
    for (const name of ["conditions.json", "go.out", "tests.log", "ignored.txt"])
      await writeFile(path.join(inputs, name), "Private original " + name);
    const recipient = path.join(directory, "recipient.pem");
    await writeFile(recipient, publicKey.export({ format: "pem", type: "spki" }));
    const destination = path.join(directory, "evidence.sealed");
    const cli = fileURLToPath(new URL("../seal-native-evidence.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [cli, inputs, recipient, destination], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    const opened = openEvidence(await readFile(destination, "utf8"), privateKey);
    assert.deepEqual(Object.keys(opened).sort(), ["conditions.json", "go.out", "tests.log"]);
    for (const [name, content] of Object.entries(opened))
      assert.equal(Buffer.from(content, "base64").toString(), "Private original " + name);
    const empty = path.join(directory, "empty");
    await mkdir(empty);
    await assert.rejects(sealDirectory(empty, publicKey, destination), /No native evidence/);
    const imported = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(new URL("../seal-native-evidence.mjs", import.meta.url).href)})`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
