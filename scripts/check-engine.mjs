/**
 * Verify the initialized engine submodule's exact commit and original per-file bytes.
 * Run from the repository root. --record rewrites checksums after the commit check; use
 * only for a deliberate reviewed engine update, never to hide accidental vendor edits.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = "vendor/choicescript";
const initialize = "git -c core.autocrlf=false submodule update --init --recursive";
const lock = JSON.parse(await readFile("vendor/choicescript.lock.json", { encoding: "utf8" }));

try {
  await access(path.join(root, ".git"));
} catch {
  throw new Error(`ChoiceScript submodule is not initialized. Run: ${initialize}`);
}

let commit;

try {
  commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
} catch {
  throw new Error("Cannot read the ChoiceScript submodule revision. Install Git and initialize the submodule.");
}

if (commit !== lock.commit)
  throw new Error(`ChoiceScript submodule is at ${commit}; expected ${lock.commit}. Run: ${initialize}`);

const actual = {};

async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name === ".git") continue;

    const file = path.join(dir, item.name);

    if (item.isDirectory()) await walk(file);
    else
      actual[path.relative(root, file).split(path.sep).join("/")] = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
  }
}

await walk(root);

if (process.argv.includes("--record")) await writeFile("vendor/checksums.json", JSON.stringify(actual, null, 2) + "\n");
else {
  const expected = JSON.parse(await readFile("vendor/checksums.json", { encoding: "utf8" }));

  if (JSON.stringify(Object.entries(expected).sort()) !== JSON.stringify(Object.entries(actual).sort()))
    throw new Error(
      "ChoiceScript files differ from the pinned snapshot. Preserve upstream bytes with core.autocrlf=false.",
    );

  console.log(`Verified ChoiceScript submodule ${commit.slice(0, 7)} (${Object.keys(actual).length} upstream files).`);
}
