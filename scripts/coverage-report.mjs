/** Normalize source-located LCOV while retaining evidence of unmappable V8 branches. */
import path from "node:path";
import { repositoryRoot } from "./artifact-paths.mjs";

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
    const lines = [];
    let branches = 0;
    let hit = 0;
    for (const line of record.trim().split(/\r?\n/)) {
      if (line.startsWith("SF:")) {
        lines.push("SF:" + file);
      } else if (line.startsWith("BRDA:undefined,")) {
        unmappedBranches.push({ file, record: line });
      } else if (line.startsWith("BRDA:")) {
        if (!/^BRDA:[1-9]\d*,\d+,\d+,(?:-|\d+)$/.test(line)) throw new Error("Invalid source-located LCOV branch");
        branches++;
        if (Number(line.split(",")[3]) > 0) hit++;
        lines.push(line);
      } else if (line.startsWith("DA:")) {
        if (!/^DA:[1-9]\d*,\d+(?:,[a-f0-9]+)?$/.test(line)) throw new Error("Invalid source-located LCOV line");
        lines.push(line);
      } else if (!line.startsWith("BRF:") && !line.startsWith("BRH:")) {
        lines.push(line);
      }
    }
    lines.push("BRF:" + branches, "BRH:" + hit, "end_of_record");
    records.push(lines.join("\n"));
  }
  return { lcov: records.join("\n") + "\n", unmappedBranches, excludedFiles };
}
