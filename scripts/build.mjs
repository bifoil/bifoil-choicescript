/**
 * Repository-root build entry point. Verify the pinned engine before copying its inventory;
 * generate the fallback grammar, bundle the server, worker, and VS Code adapter, and write notices/resources.
 * This replaces generated outputs and derives the distribution README from the root README.
 * It does not create installers, run Gradle, or establish installed-editor acceptance.
 */
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { ensureNativeArtifact, stageNativeArtifacts } from "./native-artifact.mjs";

await import("./check-engine.mjs");
await import("./check-native.mjs");
await import("./generate.mjs");

const { writeDependencyNotices } = await import("./notices.mjs");
const builds = [];
const nativeTarget = `${process.platform}-${process.arch}`;
await ensureNativeArtifact(nativeTarget);
// Rebuild owned bundle directories, so removed dependencies and engine files cannot survive.
await rm("dist/server", { recursive: true, force: true });
await mkdir("dist/server", { recursive: true });

/** @type {import("esbuild").Plugin} */
const resolver = {
  name: "local-node-resolution",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path === "vscode" || args.path.startsWith("node:") || builtinModules.includes(args.path))
        return { path: args.path, external: true };

      try {
        return {
          path: createRequire(args.importer || import.meta.url).resolve(args.path),
        };
      } catch {
        return undefined;
      }
    });
  },
};
const common = {
  plugins: [resolver],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: true,
  logLevel: "info",
  metafile: true,
};
builds.push(
  await build({
    ...common,
    entryPoints: ["packages/server/src/index.ts"],
    outfile: "dist/server/server.cjs",
  }),
);
builds.push(
  await build({
    ...common,
    entryPoints: ["packages/server/src/worker.ts"],
    outfile: "dist/server/analysis-worker.cjs",
  }),
);

for (const [entry, output] of [
  ["packages/tooling/src/broker.ts", "tool-broker.cjs"],
  ["packages/tooling/src/tool-source-preload.ts", "tool-source-preload.cjs"],
  ["packages/tooling/src/export-source-preload.ts", "export-source-preload.cjs"],
]) {
  builds.push(await build({ ...common, entryPoints: [entry], outfile: path.join("dist/server", output) }));
}

const runtime = JSON.parse(await readFile("vendor/runtime-files.json", { encoding: "utf8" }));
const engineLock = JSON.parse(await readFile("vendor/choicescript.lock.json", { encoding: "utf8" }));
const checksums = JSON.parse(await readFile("vendor/checksums.json", { encoding: "utf8" }));

if (runtime.engineCommit !== engineLock.commit) throw new Error("Runtime inventory does not match the pinned engine.");

for (const file of runtime.files) {
  if (!Object.hasOwn(checksums, file) || file.split("/").some((part) => part === ".." || part === "."))
    throw new Error("Unknown runtime inventory file: " + file);

  const destination = path.join("dist/server/vendor/choicescript", file);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join("vendor/choicescript", file), destination);
}

for (const file of ["choicescript.lock.json", "checksums.json", "runtime-files.json"])
  await cp(path.join("vendor", file), path.join("dist/server/vendor", file));

builds.push(
  await build({
    ...common,
    target: "node22",
    entryPoints: ["editors/vscode/src/extension.ts"],
    outfile: "editors/vscode/dist/extension.cjs",
    external: ["vscode"],
  }),
);
await writeDependencyNotices(builds);
await cp("THIRD_PARTY_NOTICES.md", "dist/server/THIRD_PARTY_NOTICES.md");
await cp("LICENSE", "dist/server/LICENSE");
await stageNativeArtifacts("dist/server", [nativeTarget]);
await rm("editors/vscode/server", { recursive: true, force: true });
await cp("dist/server", "editors/vscode/server", { recursive: true });

// Root-relative documentation links must also resolve in the generated extension directory.
const documentationRoot = "https://github.com/bifoil/bifoil-choicescript/blob/main/";
const readme = await readFile("README.md", { encoding: "utf8" });
await writeFile(
  "editors/vscode/README.md",
  readme.replace(
    /]\((?![a-z][\w+.-]*:|#|\/)([^\s)]+)\)/gi,
    (_, target) => "](" + new URL(target, documentationRoot).href + ")",
  ),
);
await cp("LICENSE", "editors/vscode/LICENSE");
console.log("Built shared server, analysis worker, and VS Code client.");
