import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { zipSync } from "fflate";

const execute = promisify(execFile);

test("runtime provisioning preserves verified binaries and repairs corrupt files offline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil runtime Ω "));
  try {
    const bytes = zipSync({
      "node-fixture/node.exe": Buffer.from("Original synthetic runtime bytes"),
      "node-fixture/LICENSE": Buffer.from("Synthetic license"),
    });
    const cache = path.join(root, ".cache/runtimes/win32-x64");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "node-fixture.zip"), bytes);
    await writeFile(
      path.join(root, "runtime-lock.json"),
      JSON.stringify({
        version: "fixture",
        archives: {
          "win32-x64": {
            file: "node-fixture.zip",
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        },
      }),
    );
    const module = new URL("../../../scripts/runtime.mjs", import.meta.url).href;
    const source = `
      import { provision } from ${JSON.stringify(module)};
      import {readFile,stat,writeFile} from 'node:fs/promises';
      import assert from 'node:assert/strict';
      const out=await provision('win32-x64');
      const binary=out+'/node.exe';
      const before=await stat(binary,{bigint:true});
      await new Promise(resolve=>setTimeout(resolve,25));
      await provision('win32-x64');
      assert.equal((await stat(binary,{bigint:true})).mtimeNs,before.mtimeNs);
      await writeFile(binary,'corrupted');
      await provision('win32-x64');
      assert.equal(await readFile(binary,'utf8'),'Original synthetic runtime bytes');
      await assert.rejects(provision('unsupported'),/Unsupported platform/);
      console.log('verified');
    `;
    const result = await execute(process.execPath, ["--input-type=module", "-e", source], {
      cwd: root,
      timeout: 10000,
    });
    assert.equal(result.stdout.trim(), "verified");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime downloads reject failures and corrupt cache bytes before replacing verified output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bifoil runtime download Ω "));
  try {
    const bytes = zipSync({
      "node-fixture/node.exe": Buffer.from("Original verified runtime"),
      "node-fixture/LICENSE": Buffer.from("Original license"),
    });
    await writeFile(path.join(root, "archive.zip"), bytes);
    await writeFile(
      path.join(root, "runtime-lock.json"),
      JSON.stringify({
        version: "original-fixture",
        archives: {
          "win32-x64": { file: "node-fixture.zip", sha256: createHash("sha256").update(bytes).digest("hex") },
        },
      }),
    );
    const module = new URL("../../../scripts/runtime.mjs", import.meta.url).href;
    const source = `
      import {provision} from ${JSON.stringify(module)};
      import assert from 'node:assert/strict';
      import {readFile,writeFile} from 'node:fs/promises';
      let requests=0;
      globalThis.fetch=async url=>{requests++;assert.equal(url,'https://nodejs.org/dist/original-fixture/node-fixture.zip');return new Response('unavailable',{status:503});};
      await assert.rejects(provision('win32-x64'),/Runtime download failed: 503/);
      const bytes=await readFile('archive.zip');
      globalThis.fetch=async()=>{requests++;return new Response(bytes);};
      const directory=await provision('win32-x64');
      assert.equal(requests,2);
      assert.equal(await readFile(directory+'/node.exe','utf8'),'Original verified runtime');
      await writeFile('.cache/runtimes/win32-x64/node-fixture.zip','corrupted');
      await assert.rejects(provision('win32-x64'),/Runtime checksum mismatch/);
      assert.equal(requests,2);
      assert.equal(await readFile(directory+'/node.exe','utf8'),'Original verified runtime');
      console.log('download contract verified');
    `;
    const result = await execute(process.execPath, ["--input-type=module", "-e", source], {
      cwd: root,
      timeout: 10000,
    });
    assert.equal(result.stdout.trim(), "download contract verified");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
