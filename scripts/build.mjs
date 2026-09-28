import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";

await import("./generate.mjs");
const { writeDependencyNotices } = await import("./notices.mjs");
const builds = [];
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
await cp("vendor", "dist/server/vendor", { recursive: true });
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
await cp("dist/server", "editors/vscode/server", { recursive: true });
await cp("README.md", "editors/vscode/README.md");
await cp("LICENSE", "editors/vscode/LICENSE");
console.log("Built shared server, analysis worker, and VS Code client.");
