import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { listFiles, PackageManager } from "@vscode/vsce";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const execute = promisify(execFile);
const sceneFile = "scenes/branch Ω.txt";
// VSCE exits its process when secret scanning fails, so exercise that boundary in a child.
const packageScript =
  'require("@vscode/vsce").createVSIX({cwd:process.argv[1],packagePath:process.argv[2],dependencies:false,target:process.platform+"-"+process.arch,githubBranch:"main",skipLicense:false}).catch(error=>{console.error(error);process.exitCode=1;});';

async function withFixture(run: (directory: string, output: string) => Promise<void>) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bifoil packaging Ω "));
  const directory = path.join(temporary, "extension");

  try {
    const files = {
      "package.json": JSON.stringify({
        name: "packaging-fixture",
        publisher: "bifoil",
        version: "0.0.0",
        description: "Original packaging regression fixture",
        engines: { vscode: "^1.109.0" },
        license: "MIT",
        main: "./dist/extension.cjs",
        activationEvents: ["onStartupFinished"],
        repository: { type: "git", url: "https://github.com/bifoil/bifoil-choicescript" },
      }),
      "README.md": "# Packaging fixture\n\nOriginal regression input.\n",
      LICENSE: await readFile(path.join(root, "LICENSE"), "utf8"),
      ".vscodeignore": "**/*.map\nsrc/**\ntest/**\nnode_modules/**\nignored-{one,two}/**\n",
      "dist/extension.cjs": "module.exports = {};\n",
      "dist/extension.cjs.map": "{}",
      "server/server.cjs": "module.exports = {};\n",
      "server/server.cjs.map": "{}",
      "runtime/node.exe": "synthetic runtime placeholder\n",
      [sceneFile]: "Original synthetic narrative.\n",
      "src/extension.ts": "source input\n",
      "test/internal.txt": "test input\n",
      "node_modules/unused/index.js": "unused dependency\n",
      "ignored-one/private.txt": "excluded input\n",
      "ignored-two/private.txt": "excluded input\n",
    };

    for (const [file, contents] of Object.entries(files)) {
      const destination = path.join(directory, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, contents);
    }

    await run(directory, path.join(temporary, "fixture.vsix"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const pack = (directory: string, output: string) =>
  execute(process.execPath, ["-e", packageScript, directory, output], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });

test("official VSIX packaging preserves runtime files, Unicode paths, and development exclusions", async () => {
  await withFixture(async (directory, output) => {
    const files = await listFiles({ cwd: directory, packageManager: PackageManager.None });

    assert.deepEqual(
      files.map((file) => file.split(path.sep).join("/")).sort(),
      [
        "LICENSE",
        "README.md",
        "dist/extension.cjs",
        "package.json",
        "runtime/node.exe",
        sceneFile,
        "server/server.cjs",
      ].sort(),
    );

    await pack(directory, output);

    const entries = unzipSync(await readFile(output));

    for (const file of ["package.json", "dist/extension.cjs", "server/server.cjs", "runtime/node.exe", sceneFile])
      assert(Object.hasOwn(entries, "extension/" + file), file);

    assert(Object.hasOwn(entries, "extension.vsixmanifest"));
    assert(Object.hasOwn(entries, "extension/readme.md"));
    assert(Object.hasOwn(entries, "extension/LICENSE.txt"));
    assert(
      !Object.keys(entries).some((file) => /\.map$|\/(?:src|test|node_modules|ignored-one|ignored-two)\//.test(file)),
    );
  });
});

test("official VSIX packaging rejects environment files and synthetic private keys", async () => {
  await withFixture(async (directory, output) => {
    await writeFile(path.join(directory, ".env"), "FIXTURE_VALUE=placeholder\n");
    await assert.rejects(pack(directory, output), { code: 1, stderr: /\.env.*should not be packaged/ });
    await assert.rejects(readFile(output), { code: "ENOENT" });
    await rm(path.join(directory, ".env"));

    const fakeKey = ["-----BEGIN PRIVATE KEY-----", "A".repeat(72), "-----END PRIVATE KEY-----", ""].join("\n");
    await writeFile(path.join(directory, "credentials.txt"), fakeKey);
    await assert.rejects(pack(directory, output), { code: 1, stderr: /contains sensitive information/ });
    await assert.rejects(readFile(output), { code: "ENOENT" });
  });
});
