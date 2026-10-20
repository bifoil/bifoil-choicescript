/** Build the stdlib-only native server with an installed pinned Go SDK; never download a toolchain. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeSourceDigest, nativeTargets } from "./native-artifact.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const go = process.env.BIFOIL_GO ?? "go";
const requested = process.argv[2] ?? `${process.platform}-${process.arch}`;
const targets = nativeTargets;
const target = Object.keys(targets).find((candidate) => candidate === requested);
if (!target) throw new Error("Unsupported native server target: " + target);
const environment = {
  ...process.env,
  GOTOOLCHAIN: "local",
  GOPROXY: "off",
  CGO_ENABLED: "0",
  GOWORK: "off",
  GOFLAGS: "",
};
const inspect = (args) => execFileSync(go, args, { cwd: root, env: environment, encoding: "utf8" }).trim();
const sdk = JSON.parse(await readFile(path.join(root, "native/toolchain.json"), { encoding: "utf8" }));
const version = inspect(["env", "GOVERSION"]);
if (version !== sdk.version)
  throw new Error(`Native builds require installed ${sdk.version}; found ${version}. Set BIFOIL_GO to its executable.`);
const info = JSON.parse(inspect(["env", "-json", "GOROOT", "GOHOSTOS", "GOHOSTARCH"]));
const destination = path.join(root, "dist/native", target);
await mkdir(destination, { recursive: true });
const sourceSha256 = await nativeSourceDigest();
const staging = await mkdtemp(path.join(root, "dist/native", ".build-"));
const executable = "bifoil-language-server" + (targets[target][0] === "windows" ? ".exe" : "");
const hash = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
try {
  execFileSync(
    go,
    ["build", "-pgo=off", "-buildvcs=false", "-trimpath", "-o", path.join(staging, executable), "./native/server"],
    { cwd: root, env: { ...environment, GOOS: targets[target][0], GOARCH: targets[target][1] }, stdio: "inherit" },
  );
  const tools = path.join(info.GOROOT, "pkg/tool", `${info.GOHOSTOS}_${info.GOHOSTARCH}`);
  const suffix = info.GOHOSTOS === "windows" ? ".exe" : "";
  const manifest = {
    format: 1,
    module: "github.com/bifoil/bifoil-choicescript",
    target,
    sourceSha256,
    licenseSha256: await hash(path.join(info.GOROOT, "LICENSE")),
    toolchain: {
      version,
      compilerSha256: await hash(path.join(tools, "compile" + suffix)),
      linkerSha256: await hash(path.join(tools, "link" + suffix)),
    },
    executable,
    sha256: await hash(path.join(staging, executable)),
  };
  if (sourceSha256 !== (await nativeSourceDigest()))
    throw new Error("Native source changed during compilation; rebuild.");
  await cp(path.join(info.GOROOT, "LICENSE"), path.join(staging, "GO_LICENSE.txt"));
  await writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const file of [executable, "GO_LICENSE.txt", "manifest.json"])
    await rename(path.join(staging, file), path.join(destination, file));
  console.log(`Built ${target} native server with ${version}: ${manifest.sha256}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
