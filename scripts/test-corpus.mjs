/**
 * Read-only static corpus harness: pnpm test:corpus [--details] <directories...>.
 * Each directory is isolated in a child with a 1 GiB heap and a 60-second timeout;
 * these are harness bounds, not the production combined-runtime memory requirement.
 * No game code is executed. Detailed diagnostic output can still reveal private names/paths.
 */
import { fork } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeProject } from "../packages/core/src/index.ts";
import { discoverProjects, readProject } from "../packages/tooling/src/projects.ts";

// This command only reads explicitly supplied directories. It never executes or
// copies their game code and reports metadata rather than narrative excerpts.
const args = process.argv.slice(2);

if (args[0] === "--worker") {
  const root = path.resolve(args[1]);

  if (!(await stat(root)).isDirectory()) throw new Error("Expected a directory.");

  const detected = await discoverProjects([root]);
  const projects = detected.length
    ? detected
    : [
        {
          id: pathToFileURL(root).href,
          name: path.basename(root),
          root,
          sceneDir: root,
          assetDir: root,
        },
      ];

  for (const project of projects) {
    const files = await readProject(project);

    if (!files.length) throw new Error("No scene .txt files found.");

    const start = performance.now();
    const analysis = analyzeProject(files);
    const counts = {};
    const locations = [];
    let errors = 0,
      invalidTokens = 0;

    for (const [uri, diagnostics] of analysis.diagnostics) {
      for (const diagnostic of diagnostics) {
        counts[diagnostic.code] = (counts[diagnostic.code] ?? 0) + 1;
        if (diagnostic.severity === 1) errors++;

        if (args.includes("--details"))
          locations.push({
            file: path.relative(root, fileURLToPath(uri)),
            line: diagnostic.range.start.line + 1,
            column: diagnostic.range.start.character + 1,
            code: diagnostic.code,
            message: diagnostic.message,
          });
      }
    }

    for (const [uri, tokens] of analysis.tokens) {
      const lines = analysis.documents.get(uri).lines;

      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i],
          previous = tokens[i - 1];

        if (
          token.start < 0 ||
          token.length <= 0 ||
          token.start + token.length > (lines[token.line]?.raw.length ?? -1) ||
          (previous &&
            (token.line < previous.line ||
              (token.line === previous.line && token.start < previous.start + previous.length)))
        )
          invalidTokens++;
      }
    }

    console.log(
      JSON.stringify({
        directory: path.basename(root),
        sceneDirectory: path.relative(root, project.sceneDir) || ".",
        mode: detected.length ? "detected project" : "explicit scene fragments",
        files: files.length,
        lines: [...analysis.documents.values()].reduce((sum, doc) => sum + doc.lines.length, 0),
        bytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0),
        analysisMs: Math.round(performance.now() - start),
        rssMiB: Math.round(process.memoryUsage().rss / 1024 ** 2),
        truncated: analysis.truncated,
        invalidTokens,
        errors,
        diagnostics: counts,
        ...(args.includes("--details") ? { locations } : {}),
      }),
    );
    if (analysis.truncated || invalidTokens || errors) process.exitCode = 1;
  }
} else {
  const directories = args.filter((arg) => arg !== "--details");

  if (!directories.length || args.includes("--help")) {
    console.log("Usage: pnpm test:corpus [--details] <game-or-scenes-directory> [...directories]");
    console.log(
      "Read-only analysis; one JSON summary per project. Exit 1 for errors, invalid tokens, truncation, or worker failure. Narrative warnings do not fail the run.",
    );
    if (!args.includes("--help")) process.exitCode = 1;
  } else
    for (const directory of directories) {
      // Isolate heaps and cap pathological input without downloading any runtime.
      const code = await new globalThis.Promise((resolve) => {
        const child = fork(
          fileURLToPath(import.meta.url),
          ["--worker", directory, ...(args.includes("--details") ? ["--details"] : [])],
          {
            execArgv: [...process.execArgv, "--max-old-space-size=1024"],
            stdio: ["ignore", "inherit", "inherit", "ipc"],
          },
        );
        const timer = setTimeout(() => {
          console.error(`${path.basename(directory)}: analysis exceeded 60 seconds.`);
          child.kill("SIGKILL");
        }, 60_000);
        child.once("error", (error) => {
          clearTimeout(timer);
          console.error(error.message);
          resolve(1);
        });

        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code ?? 1);
        });
      });

      if (code !== 0) process.exitCode = 1;
    }
}
