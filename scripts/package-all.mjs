import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const lock = JSON.parse(await readFile("runtime-lock.json", { encoding: "utf8" }));
const hashes = [];
for (const target of Object.keys(lock.archives)) {
  console.log("Packaging VS Code: " + target);
  execFileSync(process.execPath, ["scripts/package-vscode.mjs", target], {
    stdio: "inherit",
  });
  const file = "bifoil-choicescript-" + target + ".vsix";
  hashes.push(
    createHash("sha256")
      .update(await readFile("dist/packages/" + file))
      .digest("hex") +
      "  " +
      file,
  );
}
await writeFile("dist/packages/SHA256SUMS.txt", hashes.join("\n") + "\n");
