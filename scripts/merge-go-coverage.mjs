/** Union hits from matching Go source blocks across native platforms; never average their percentages. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPath } from "./artifact-paths.mjs";

export function mergeGoCoverage(profiles) {
  const blocks = new Map();
  for (const profile of profiles) {
    const rows = profile.trim().split(/\r?\n/);
    if (!/^mode: (?:set|count|atomic)$/.test(rows.shift() ?? "")) throw new Error("Invalid Go coverage mode.");
    for (const row of rows) {
      const last = row.lastIndexOf(" "),
        previous = row.lastIndexOf(" ", last - 1);
      const location = row.slice(0, previous),
        statements = Number(row.slice(previous + 1, last)),
        count = Number(row.slice(last + 1));
      if (
        previous < 0 ||
        !/^.+:\d+\.\d+,\d+\.\d+$/.test(location) ||
        !Number.isSafeInteger(statements) ||
        statements < 0 ||
        !Number.isSafeInteger(count) ||
        count < 0
      )
        throw new Error("Invalid Go coverage block.");
      const old = blocks.get(location);
      if (old && old.statements !== statements) throw new Error("Go profiles came from different source blocks.");
      blocks.set(location, { statements, hit: count > 0 || !!old?.hit });
    }
  }
  return (
    "mode: set\n" +
    [...blocks]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([location, block]) => `${location} ${block.statements} ${Number(block.hit)}`)
      .join("\n") +
    "\n"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [destination, ...inputs] = process.argv.slice(2);
  if (!destination || !inputs.length) throw new Error("Supply an output coverage path and input Go profiles.");
  const output = await artifactPath(destination);
  const profiles = await globalThis.Promise.all(
    inputs.map(async (input) => readFile(await artifactPath(input), "utf8")),
  );
  await writeFile(output, mergeGoCoverage(profiles));
}
