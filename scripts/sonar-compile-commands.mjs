/** Describe the shipped wasm32 compilation unit, not the native coverage-test shim. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function wasmCompileCommands(root) {
  if (!path.isAbsolute(root)) throw new Error("The compilation database requires an absolute repository root");
  root = path.resolve(root);
  const source = path.join(root, "native/environment/environment.c");
  return [
    {
      directory: root,
      file: source,
      arguments: [
        "clang",
        "--target=wasm32",
        "-O3",
        "-msimd128",
        "-fno-builtin",
        "-nostdlib",
        "-c",
        source,
        "-o",
        path.join(root, "dist/coverage/c/environment.o"),
      ],
    },
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const directory = path.join(root, "dist/coverage/c");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "compile_commands.json"),
    JSON.stringify(wasmCompileCommands(root), null, 2) + "\n",
  );
}
