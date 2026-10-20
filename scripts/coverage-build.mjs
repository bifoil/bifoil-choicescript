/** Compile coverage-only test bundles with real source text and maps; preserve each module's asset URLs. */
import { build, transform } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./artifact-paths.mjs";

export async function buildCoverageTests(files, { liveEntryURLs = false } = {}) {
  const selfHosted = new Set(liveEntryURLs ? files.map((file) => path.resolve(repositoryRoot, file)) : []);
  const output = path.join(repositoryRoot, ".cache/coverage/tests");
  await build({
    entryPoints: files,
    outdir: output,
    outbase: repositoryRoot,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    sourcemap: "inline",
    alias: {
      "@bifoil/choicescript-core": path.join(repositoryRoot, "packages/core/src/index.ts"),
      "@bifoil/choicescript-protocol": path.join(repositoryRoot, "packages/protocol/src/index.ts"),
      "@bifoil/choicescript-tooling": path.join(repositoryRoot, "packages/tooling/src/index.ts"),
    },
    banner: {
      js: 'import { createRequire as coverageRequire } from "node:module"; const require = coverageRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "original-module-urls",
        setup(builder) {
          builder.onLoad({ filter: /\.(?:ts|mjs|cjs)$/ }, async ({ path: file }) => {
            const source = await readFile(file, "utf8");
            const result = await transform(source, {
              loader: file.endsWith(".ts") ? "ts" : "js",
              sourcefile: file,
              sourcemap: "inline",
              define: selfHosted.has(file) ? {} : { "import.meta.url": JSON.stringify(pathToFileURL(file).href) },
            });
            return { contents: result.code, loader: "js", resolveDir: path.dirname(file) };
          });
        },
      },
    ],
  });
  return files.map((file) => path.join(output, file.replace(/\.(?:ts|mjs)$/, ".mjs")));
}
