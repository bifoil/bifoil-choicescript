/** Bound developer-generated artifacts to explicit repository output areas, including existing symlink ancestors. */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

/** A root must already exist; descendants may be new. Reject links rather than writing through them. */
export async function confinedPath(root, value) {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value))
    throw new Error("Invalid artifact path");
  const base = await realpath(root);
  const target = path.resolve(root, value);
  if (!inside(path.resolve(root), target)) throw new Error("Artifact path escapes its output directory");

  const segments = path.relative(path.resolve(root), target).split(path.sep).filter(Boolean);
  if (
    segments.some(
      (segment) => /[. ]$|[:*?"<>|]/.test(segment) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment),
    )
  )
    throw new Error("Artifact path contains a nonportable filename");
  let current = path.resolve(root);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !inside(base, await realpath(current)))
        throw new Error("Artifact paths must not traverse symbolic links");
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }

  return target;
}

/** Output CLI arguments may select these generated areas, never repository source or an external path. */
export async function artifactPath(
  value,
  areas = ["dist", "release", "downloaded", ".bifoil-choicescript/development"],
) {
  const target = await confinedPath(repositoryRoot, value);
  if (!areas.some((area) => inside(path.resolve(repositoryRoot, area), target)))
    throw new Error("Select an artifact path under " + areas.join(", "));
  return target;
}

/** Release checksum files describe portable, immediate regular files; no paths or filesystem aliases. */
export async function releaseFile(directory, name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    throw new Error("Invalid release asset name");
  const target = await confinedPath(directory, name);
  try {
    if (!(await lstat(target)).isFile()) throw new Error("Release assets must be regular files");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return target;
}
