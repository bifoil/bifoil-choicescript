import {
  readFile,
  writeFile,
  readdir,
  copyFile,
  mkdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const directory = path.resolve(process.argv[2] ?? "release");
await mkdir(directory, { recursive: true });
const lock = JSON.parse(await readFile("runtime-lock.json", "utf8"));
const names = await readdir(directory);
const targets = Object.keys(lock.archives).sort();
for (const target of targets) {
  if (!names.includes(`choicescript-tools-${target}.vsix`))
    throw new Error(`Missing package for ${target}`);
}
const native = names.filter((name) => name.endsWith(".zip"));
if (
  native.length !== 1 ||
  names.filter((name) => name.endsWith(".vsix")).length !== 6
)
  throw new Error("Expected six VSIX files and one universal JetBrains ZIP");
const version = JSON.parse(await readFile("package.json", "utf8")).version;
if (!process.env.GITHUB_SHA || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA))
  throw new Error("GITHUB_SHA must identify the verified source commit");
for (const [source, destination] of [
  ["LICENSE", "BRANCHLIGHT-LICENSE.txt"],
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ["vendor/choicescript/LICENSE.txt", "CHOICESCRIPT-LICENSE.txt"],
  ["vendor/choicescript.lock.json", "choicescript.lock.json"],
  ["vendor/checksums.json", "engine-checksums.json"],
  ["runtime-lock.json", "runtime-lock.json"],
  ["pnpm-lock.yaml", "pnpm-lock.yaml"],
  ["docs/provenance/gradle-linux-x64.xml", "gradle-linux-x64.xml"],
  ["docs/editor-validation.md", "EDITOR-VALIDATION.md"],
])
  await copyFile(source, path.join(directory, destination));
const artifacts = [];
for (const file of [
  ...targets.map((target) => `choicescript-tools-${target}.vsix`),
  ...native,
]) {
  const bytes = await readFile(path.join(directory, file));
  artifacts.push({
    file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await writeFile(
  path.join(directory, "release-manifest.json"),
  JSON.stringify(
    {
      name: "Branchlight",
      version,
      commit: process.env.GITHUB_SHA,
      prerelease: true,
      independent: "Unaffiliated with Choice of Games or upstream ChoiceScript",
      engine: JSON.parse(
        await readFile("vendor/choicescript.lock.json", "utf8"),
      ),
      artifacts,
      targets,
      validationRun: process.env.GITHUB_RUN_ID ?? null,
      openGates:
        "See EDITOR-VALIDATION.md; manual UI validation remains required.",
    },
    null,
    2,
  ) + "\n",
);
const checksums = [];
for (const file of (await readdir(directory))
  .filter((name) => name !== "SHA256SUMS.txt")
  .sort()) {
  const digest = createHash("sha256")
    .update(await readFile(path.join(directory, file)))
    .digest("hex");
  checksums.push(`${digest}  ${file}`);
}
await writeFile(
  path.join(directory, "SHA256SUMS.txt"),
  checksums.join("\n") + "\n",
);
console.log(
  "Prepared seven packages, dependency provenance, notices and SHA-256 checksums.",
);
