/** Verify the checked portable arena without requiring a compiler for normal builds. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const source = (await readFile("native/environment/environment.c", { encoding: "utf8" })).replace(/\r\n/g, "\n");
const generated = await readFile("packages/core/src/environment-binary.ts", { encoding: "utf8" });
const sourceSha = /environmentSourceSha256 = "([a-f0-9]{64})"/.exec(generated)?.[1];
const binarySha = /environmentBinarySha256 = "([a-f0-9]{64})"/.exec(generated)?.[1];
const body = generated.slice(
  generated.indexOf("export const environmentBinary =") + "export const environmentBinary =".length,
);
const bytes = Buffer.from([...body.matchAll(/"([A-Za-z0-9+/=]+)"/g)].map((match) => match[1]).join(""), "base64");
const sha = (value) => createHash("sha256").update(value).digest("hex");
if (!sourceSha || !binarySha || sourceSha !== sha(source) || binarySha !== sha(bytes))
  throw new Error(
    "The portable environment is stale or corrupt. Regenerate it with pnpm native:build using installed Clang and wasm-ld.",
  );
if (!WebAssembly.validate(bytes)) throw new Error("The checked environment module is invalid WebAssembly.");
console.log(`Verified original compiled environment (${bytes.length} bytes).`);
