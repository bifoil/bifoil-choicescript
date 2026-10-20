/** Regenerate the checked portable arena using installed Clang and wasm-ld; no downloads. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const source = "native/environment/environment.c";
const directory = await mkdtemp(path.join(os.tmpdir(), "bifoil-native-"));
try {
  const clang = process.env.BIFOIL_CLANG ?? "clang";
  const linker = process.env.BIFOIL_WASM_LD ?? "wasm-ld";
  const object = path.join(directory, "environment.o"),
    output = path.join(directory, "environment.wasm");
  execFileSync(
    clang,
    ["--target=wasm32", "-O3", "-msimd128", "-fno-builtin", "-nostdlib", "-c", source, "-o", object],
    { stdio: "inherit" },
  );
  execFileSync(
    linker,
    [
      "--no-entry",
      "--export-memory",
      "--initial-memory=262144",
      "--max-memory=50331648",
      "-z",
      "stack-size=65536",
      object,
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );
  const bytes = await readFile(output),
    sourceBytes = (await readFile(source, "utf8")).replace(/\r\n/g, "\n");
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const module = `/** Generated from native/environment/environment.c; regenerate with pnpm native:build. */\nexport const environmentSourceSha256 = "${sha(sourceBytes)}";\nexport const environmentBinarySha256 = "${sha(bytes)}";\nexport const environmentBinary =\n${bytes
    .toString("base64")
    .match(/.{1,112}/g)
    .map((part) => `  "${part}"`)
    .join(" +\n")};\n`;
  await writeFile("packages/core/src/environment-binary.ts", module);
  console.log(`Generated ${bytes.length} verified portable environment bytes.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
