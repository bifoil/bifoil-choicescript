/** Collect LLVM coverage from the unchanged arena algorithm with a native wasm-ABI test shim. */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { artifactPath, repositoryRoot } from "./artifact-paths.mjs";

if (process.platform !== "linux")
  throw new Error("The native arena coverage shim requires Linux; shipped wasm tests run on all hosts.");
const bin = process.env.BIFOIL_LLVM_BIN;
if (!bin || !path.isAbsolute(bin))
  throw new Error("Set BIFOIL_LLVM_BIN to a matched LLVM installation's absolute bin directory.");
const output = await artifactPath("dist/coverage/c");
await mkdir(output, { recursive: true });
const executable = path.join(output, "environment-test"),
  raw = path.join(output, "environment.profraw"),
  profile = path.join(output, "environment.profdata");
const run = (tool, args, extra = {}) =>
  execFileSync(path.join(bin, tool), args, { cwd: repositoryRoot, encoding: "utf8", ...extra });
run("clang", [
  "-O0",
  "-g",
  "-fprofile-instr-generate",
  "-fcoverage-mapping",
  "-fno-pie",
  "-no-pie",
  "-Wno-pointer-to-int-cast",
  "-Wno-int-to-pointer-cast",
  "native/environment/test/environment_test.c",
  "-o",
  executable,
]);
console.log(execFileSync(executable, [], { encoding: "utf8", env: { ...process.env, LLVM_PROFILE_FILE: raw } }).trim());
run("llvm-profdata", ["merge", "-sparse", raw, "-o", profile]);
const lcov = run("llvm-cov", ["export", executable, "-instr-profile=" + profile, "-format=lcov"]);
await writeFile(path.join(output, "environment.lcov"), lcov);
const record = lcov.split("end_of_record").find((record) => {
  const source = /^SF:(.+)$/m.exec(record)?.[1];
  return source && path.resolve(source) === path.join(repositoryRoot, "native/environment/environment.c");
});
if (!record) throw new Error("LLVM did not report the original environment source.");
const lines = new Map();
for (const match of record.matchAll(/^DA:(\d+),(\d+)/gm))
  lines.set(Number(match[1]), { covered: Number(match[2]) > 0, branches: 0, hit: 0 });
for (const match of record.matchAll(/^BRDA:(\d+),\d+,\d+,(-|\d+)/gm)) {
  const line = lines.get(Number(match[1]));
  if (!line) throw new Error("LLVM branch has no corresponding source line.");
  line.branches++;
  if (Number(match[2]) > 0) line.hit++;
}
const rows = [...lines].map(
  ([number, line]) =>
    `    <lineToCover lineNumber="${number}" covered="${line.covered}"${line.branches ? ` branchesToCover="${line.branches}" coveredBranches="${line.hit}"` : ""}/>`,
);
await writeFile(
  path.join(output, "coverage.xml"),
  '<coverage version="1">\n  <file path="native/environment/environment.c">\n' +
    rows.join("\n") +
    "\n  </file>\n</coverage>\n",
);
await writeFile(
  path.join(output, "toolchain.json"),
  JSON.stringify(
    {
      clang: run("clang", ["--version"]).trim(),
      llvmCov: run("llvm-cov", ["--version"]).trim(),
      source: "native/environment/environment.c",
      coverage: "native host shim; the shipped wasm is tested separately",
    },
    null,
    2,
  ) + "\n",
);
console.log(`Recorded ${lines.size} original C source lines in dist/coverage/c/coverage.xml.`);
