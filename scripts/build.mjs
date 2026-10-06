import { build } from "esbuild";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";

await import("./check-engine.mjs");
await import("./generate.mjs");
const { writeDependencyNotices } = await import("./notices.mjs");
const builds = [];
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
await rm("editors/vscode/server", { recursive: true, force: true });
await cp("dist/server", "editors/vscode/server", { recursive: true });
await cp("README.md", "editors/vscode/README.md");
await cp("LICENSE", "editors/vscode/LICENSE");
console.log("Built shared server, analysis worker, and VS Code client.");
