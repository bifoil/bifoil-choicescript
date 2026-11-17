import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { zipSync } from "fflate";

const run = promisify(execFile);
const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Only the HTTP response is replaced. The original provisioner checks real ZIP
// bytes, writes actual files, and records their provenance in an owned directory.
test("runtime provisioning verifies downloads, preserves installed bytes and rejects corrupted archives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil runtime contract Ω "));
  const prefix = "node-original-win-x64";
  const binary = Buffer.from("Original runtime fixture, never executed");
  const archive = zipSync({
    [prefix + "/node.exe"]: binary,
    [prefix + "/LICENSE"]: Buffer.from("Original fixture license"),
    [prefix + "/unused.txt"]: Buffer.from("Not an installed resource"),
  });
  try {
    await writeFile(path.join(root, "download.zip"), archive);
    await writeFile(
      path.join(root, "runtime-lock.json"),
      JSON.stringify({
        version: "original-contract",
        archives: { "win32-x64": { file: prefix + ".zip", sha256: checksum(archive) } },
      }),
    );
    const script = `
      import assert from 'node:assert/strict';
      import {readFile,writeFile,stat,mkdir,rm} from 'node:fs/promises';
      import path from 'node:path';
      let requests=0;
      globalThis.fetch=async(url)=>{
        requests++;
        assert.equal(url,'https://nodejs.org/dist/original-contract/${prefix}.zip');
        return new Response(await readFile('download.zip'));
      };
      const {provision}=await import(${JSON.stringify(new URL("../runtime.mjs", import.meta.url).href)});
      const output=await provision('win32-x64');
      assert.equal(requests,1);
      assert.equal((await readFile(path.join(output,'node.exe'))).toString(),${JSON.stringify(binary.toString())});
      assert.equal(await readFile(path.join(output,'NODE-LICENSE'),'utf8'),'Original fixture license');
      const manifest=JSON.parse(await readFile(path.join(output,'provenance.json'),'utf8'));
      assert.equal(manifest.archiveSha256,${JSON.stringify(checksum(archive))});
      assert.equal(manifest.binarySha256,${JSON.stringify(checksum(binary))});
      const before=(await stat(path.join(output,'node.exe'),{bigint:true})).mtimeNs;
      await provision('win32-x64');
      assert.equal(requests,1,'verified cached archives must avoid another request');
      assert.equal((await stat(path.join(output,'node.exe'),{bigint:true})).mtimeNs,before);
      await writeFile(path.join(output,'node.exe'),'Outdated fixture');
      await provision('win32-x64');
      assert.equal((await readFile(path.join(output,'node.exe'))).toString(),${JSON.stringify(binary.toString())});
      const cached=path.join('.cache/runtimes/win32-x64',${JSON.stringify(prefix + ".zip")});
      await writeFile(cached,'Corrupted bytes');
      await assert.rejects(provision('win32-x64'),/checksum mismatch/);
      await rm(cached);
      globalThis.fetch=async()=>new Response('Unavailable',{status:503});
      await assert.rejects(provision('win32-x64'),/download failed: 503/);
      await assert.rejects(readFile(cached),{code:'ENOENT'});
      await writeFile(cached,await readFile('download.zip'));
      await rm(path.join(output,'node.exe'));
      await mkdir(path.join(output,'node.exe'));
      await assert.rejects(provision('win32-x64'),error=>['EISDIR','EPERM','EACCES'].includes(error.code));
    `;
    await run(process.execPath, ["--input-type=module", "--eval", script], { cwd: root, timeout: 20000 });
    assert.equal(await readFile(path.join(root, "dist/runtime/win32-x64/NODE-LICENSE"), "utf8"), "Original fixture license");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
