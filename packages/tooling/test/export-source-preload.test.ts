import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";
import { ToolRunner, discoverProjects } from "@bifoil/choicescript-tooling";

const execute = promisify(execFile);

test(
  "bounded official compilation preserves exact HTML, Unicode, images, CRC and labels",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bifoil compile Ω "));
    const runner = new ToolRunner(path.resolve("vendor/choicescript"), () => {});
    let stage: string | undefined;
    try {
      const game = path.join(root, "game"),
        scenes = path.join(game, "scenes");
      await mkdir(scenes, { recursive: true });
      await writeFile(path.join(game, "logo.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      await writeFile(
        path.join(scenes, "startup.txt"),
        "\ufeff*title Original Ω\r\n*author Chinay\r\n*ifid 6158464D-F392-4570-B093-505689FD14F0\r\n*create score 1\r\n*scene_list\r\n  startup\r\n  chapter\r\n*text_image logo.png Original alt text\r\n*finish\r\n",
      );
      await writeFile(
        path.join(scenes, "chapter.txt"),
        '*label original\nShe said "Escaped \\" ${score} — Ω 😀."\n*ending\n',
      );
      await writeFile(
        path.join(scenes, "choicescript_stats.txt"),
        Array.from({ length: 160 }, (_, line) => `Original ${line % 80} — Ω 😀 \\".`).join("\n"),
      );
      const [project] = await discoverProjects([game]);
      stage = await runner.stage(project, []);
      const bridge = path.join(root, "root.cjs"),
        preload = path.join(root, "export-source-preload.cjs");
      await writeFile(bridge, "global.rootDir = 'web/';\n");
      await build({
        entryPoints: ["packages/tooling/src/export-source-preload.ts"],
        outfile: preload,
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node24",
        logLevel: "silent",
      });
      const baseline = await execute(
        process.execPath,
        ["--max-old-space-size=64", "--require", bridge, "compile.js", "baseline.html"],
        { cwd: stage, timeout: 20000, maxBuffer: 1024 * 1024 },
      );
      const adapted = await execute(
        process.execPath,
        ["--max-old-space-size=64", "--require", preload, "compile.js", "adapted.html"],
        { cwd: stage, timeout: 20000, maxBuffer: 1024 * 1024 },
      );
      const expected = await readFile(path.join(stage, "baseline.html"));
      assert.deepEqual(await readFile(path.join(stage, "adapted.html")), expected);
      assert.equal(adapted.stderr, baseline.stderr);
      assert.equal(
        adapted.stdout.replaceAll("adapted.html", "OUTPUT.html"),
        baseline.stdout.replaceAll("baseline.html", "OUTPUT.html"),
      );
      assert(expected.includes(Buffer.from("data:image/png;base64,")));
      assert(!expected.includes(Buffer.from("BIFOIL_EXPORT_")));
    } finally {
      await runner.dispose();
      if (stage) await rm(stage, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
);
