/** Normalize source-located LCOV while retaining evidence of unmappable V8 branches. */
import path from "node:path";
import { artifactPath, repositoryRoot } from "./artifact-paths.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function branchCount(line) {
  if (!/^BRDA:[1-9]\d*,\d+,\d+,(?:-|\d+)$/.test(line)) throw new Error("Invalid source-located LCOV branch");
  return Number(line.split(",")[3]);
}

function normalizeRecord(record, file, unmappedBranches) {
  const lines = [];
  let branches = 0;
  let hit = 0;
  for (const line of record.trim().split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      lines.push("SF:" + file);
    } else if (line.startsWith("BRDA:undefined,")) {
      unmappedBranches.push({ file, record: line });
    } else if (line.startsWith("BRDA:")) {
      const count = branchCount(line);
      branches++;
      if (count > 0) hit++;
      lines.push(line);
    } else if (line.startsWith("DA:")) {
      if (!/^DA:[1-9]\d*,\d+(?:,[a-f0-9]+)?$/.test(line)) throw new Error("Invalid source-located LCOV line");
      lines.push(line);
    } else if (!line.startsWith("BRF:") && !line.startsWith("BRH:")) {
      lines.push(line);
    }
  }
  lines.push("BRF:" + branches, "BRH:" + hit, "end_of_record");
  return lines.join("\n");
}

export function normalizeCoverage(raw) {
  const unmappedBranches = [];
  const excludedFiles = [];
  const records = [];
  for (const record of raw.split("end_of_record")) {
    const source = /^SF:(.+)$/m.exec(record)?.[1];
    if (!source) continue;
    const file = (path.isAbsolute(source) ? path.relative(repositoryRoot, source) : source).replaceAll("\\", "/");
    const original = /^(?:packages\/[^/]+\/src\/.*\.ts|editors\/vscode\/src\/.*\.ts|scripts\/.*\.(?:mjs|cjs))$/.test(
      file,
    );
    if (!original || file === "packages/core/src/environment-binary.ts" || file.includes("/test/")) {
      excludedFiles.push(file);
      continue;
    }
    records.push(normalizeRecord(record, file, unmappedBranches));
  }
  return { lcov: records.join("\n") + "\n", unmappedBranches, excludedFiles };
}

function coverageCounters(block) {
  const counters = new Map();
  for (const row of block.split(/\r?\n/)) {
    if (!row.startsWith("DA:") && !row.startsWith("BRDA:")) continue;
    const separator = row.lastIndexOf(",");
    const key = row.slice(0, separator),
      raw = row.slice(separator + 1);
    const count = raw === "-" ? 0 : Number(raw);
    if (counters.has(key) || !Number.isSafeInteger(count)) throw new Error("Invalid or duplicate LCOV counter");
    counters.set(key, count);
  }
  return counters;
}

function coverageFiles(profile) {
  const files = new Map();
  for (const block of normalizeCoverage(profile).lcov.split("end_of_record")) {
    const name = /^SF:(.+)$/m.exec(block)?.[1];
    if (!name) continue;
    if (files.has(name)) throw new Error("Duplicate LCOV source: " + name);
    files.set(name, coverageCounters(block));
  }
  if (!files.size) throw new Error("LCOV report contains no maintained source coverage");
  return files;
}

function unionCounters(previous, counters, name) {
  if (!previous || previous.size !== counters.size || [...counters.keys()].some((key) => !previous.has(key)))
    throw new Error("LCOV reports describe different source counters: " + name);
  for (const [key, count] of counters) {
    const total = previous.get(key) + count;
    if (!Number.isSafeInteger(total)) throw new Error("LCOV counter overflow");
    previous.set(key, total);
  }
}

function coverageRecord(name, counters) {
  const rows = [...counters].map(([key, count]) => key + "," + count);
  const lines = [...counters].filter(([key]) => key.startsWith("DA:"));
  const branches = [...counters].filter(([key]) => key.startsWith("BRDA:"));
  return [
    "SF:" + name,
    ...rows,
    "LF:" + lines.length,
    "LH:" + lines.filter(([, hit]) => hit > 0).length,
    "BRF:" + branches.length,
    "BRH:" + branches.filter(([, hit]) => hit > 0).length,
    "end_of_record",
  ].join("\n");
}

/** Union observed hits only when both reports describe identical source counters. */
export function mergeCoverage(profiles) {
  if (!profiles.length) throw new Error("Supply at least one LCOV report");
  const files = coverageFiles(profiles[0]);
  for (const profile of profiles.slice(1))
    for (const [name, counters] of coverageFiles(profile)) unionCounters(files.get(name), counters, name);
  return [...files].map(([name, counters]) => coverageRecord(name, counters)).join("\n") + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [destination, ...inputs] = process.argv.slice(2);
  if (!destination || !inputs.length) throw new Error("Supply an output coverage path and input LCOV profiles");
  const profiles = await Promise.all(inputs.map(async (input) => readFile(await artifactPath(input), "utf8")));
  await writeFile(await artifactPath(destination), mergeCoverage(profiles));
}
