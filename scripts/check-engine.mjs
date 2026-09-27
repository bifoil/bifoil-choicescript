import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const root = "vendor/choicescript",
  actual = {};
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) await walk(file);
    else
      actual[path.relative(root, file).split(path.sep).join("/")] = createHash(
        "sha256",
      )
        .update(await readFile(file))
        .digest("hex");
  }
}
await walk(root);
if (process.argv.includes("--record"))
  await writeFile(
    "vendor/checksums.json",
    JSON.stringify(actual, null, 2) + "\n",
  );
else {
  const expected = JSON.parse(await readFile("vendor/checksums.json", "utf8"));
  if (
    JSON.stringify(Object.entries(expected).sort()) !==
    JSON.stringify(Object.entries(actual).sort())
  )
    throw new Error(
      "Vendored ChoiceScript files differ from the pinned snapshot.",
    );
  console.log(
    "Verified " + Object.keys(actual).length + " pinned upstream files.",
  );
}
