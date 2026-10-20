/** Resolve build-time utilities from explicit installations instead of searching a caller-controlled PATH. */
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export async function hostTool(name) {
  const windows = process.platform === "win32";
  const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const installations = windows
    ? {
        git: [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git/cmd/git.exe")],
        tar: [path.join(system, "tar.exe")],
        powershell: [path.join(system, "WindowsPowerShell/v1.0/powershell.exe")],
      }
    : { git: ["/usr/bin/git", "/bin/git"], tar: ["/usr/bin/tar", "/bin/tar"] };
  if (!Object.hasOwn(installations, name)) throw new Error("Unsupported host tool");

  const override = process.env[`BIFOIL_${name.toUpperCase()}`];
  if (override && !path.isAbsolute(override)) throw new Error(`BIFOIL_${name.toUpperCase()} must be an absolute path`);

  for (const candidate of override ? [override] : installations[name]) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
    }
  }

  throw new Error(
    `Install ${name} in its standard location or set BIFOIL_${name.toUpperCase()} to its absolute executable path.`,
  );
}
