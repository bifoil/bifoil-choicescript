import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { repositoryRoot } from "../artifact-paths.mjs";

const run = promisify(execFile);

// Only the external LLVM/executable boundary is substituted. Synthetic reports
// are restored in finally and must never become a real scanner input.
test(
  "native coverage rejects unavailable tools and invalid source reports without losing real evidence",
  {
    skip: process.platform !== "linux" && "Native coverage driver requires Linux",
  },
  async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "bifoil coverage tool boundary "));
    const outputs = ["environment.lcov", "coverage.xml", "toolchain.json"];
    const directory = path.join(repositoryRoot, "dist/coverage/c");
    const saved = new Map();
    for (const file of outputs)
      saved.set(
        file,
        await readFile(path.join(directory, file)).catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        }),
      );
    try {
      const hook = path.join(temporary, "llvm-boundary.mjs"),
        trace = path.join(temporary, "calls.json");
      await writeFile(
        hook,
        `
      import child from "node:child_process";
      import {writeFileSync} from "node:fs";
      import path from "node:path";
      import {syncBuiltinESMExports} from "node:module";
      const calls=[];
      child.execFileSync=(file,args=[])=>{
        calls.push({file,args});
        writeFileSync(process.env.BIFOIL_C_DRIVER_TRACE,JSON.stringify(calls));
        if(process.env.BIFOIL_C_DRIVER_MODE==="tool-error") throw new Error("Original LLVM boundary failure");
        if(path.basename(file)==="llvm-cov" && args[0]==="export") return process.env.BIFOIL_C_DRIVER_REPORT;
        return "Original native tool result\\n";
      };
      syncBuiltinESMExports();
    `,
      );
      const source = path.join(repositoryRoot, "native/environment/environment.c");
      const report = `SF:${source}\nDA:1,1\nDA:2,0\nBRDA:1,0,0,1\nBRDA:1,0,1,0\nend_of_record\n`;
      const invoke = (mode, llvm = temporary, input = report) =>
        run(process.execPath, ["--import", pathToFileURL(hook).href, "scripts/test-coverage-c.mjs"], {
          cwd: repositoryRoot,
          timeout: 10000,
          env: {
            ...process.env,
            BIFOIL_LLVM_BIN: llvm,
            BIFOIL_C_DRIVER_MODE: mode,
            BIFOIL_C_DRIVER_REPORT: input,
            BIFOIL_C_DRIVER_TRACE: trace,
          },
        });
      await assert.rejects(invoke("success", ""), /matched LLVM installation/);
      await assert.rejects(invoke("success", "relative"), /matched LLVM installation/);
      await assert.rejects(invoke("tool-error"), /Original LLVM boundary failure/);
      await assert.rejects(
        invoke("success", temporary, "SF:unrelated.c\nDA:1,1\nend_of_record\n"),
        /original environment source/,
      );
      await assert.rejects(
        invoke("success", temporary, report.replace("BRDA:1,0,0,1", "BRDA:3,0,0,1")),
        /no corresponding source line/,
      );
      await invoke("success");
      const xml = await readFile(path.join(directory, "coverage.xml"), "utf8");
      assert.match(xml, /lineNumber="1" covered="true" branchesToCover="2" coveredBranches="1"/);
      assert.match(xml, /lineNumber="2" covered="false"/);
      const calls = JSON.parse(await readFile(trace, "utf8"));
      assert(
        calls.some(
          ({ args }) =>
            args.includes("native/environment/test/environment_test.c") && args.includes("-fcoverage-mapping"),
        ),
      );
      assert(calls.some(({ file, args }) => path.basename(file) === "llvm-profdata" && args[0] === "merge"));
    } finally {
      for (const [file, bytes] of saved) {
        const target = path.join(directory, file);
        if (bytes === undefined) await rm(target, { force: true });
        else await writeFile(target, bytes);
      }
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
