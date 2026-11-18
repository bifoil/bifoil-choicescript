/** Encrypt private native dependency evidence before it leaves the integration runner. */
import { createCipheriv, createDecipheriv, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FORMAT = "bifoil.private-native-evidence.v1";
const aad = Buffer.from(FORMAT);

export function sealEvidence(files, recipient) {
  const key = randomBytes(32),
    iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(JSON.stringify(files), "utf8"), cipher.final()]);
  return JSON.stringify({
    format: FORMAT,
    key: publicEncrypt({ key: recipient, oaepHash: "sha256" }, key).toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    body: body.toString("base64"),
  });
}

export function openEvidence(sealed, recipient) {
  const envelope = JSON.parse(sealed);
  if (envelope.format !== FORMAT) throw new Error("Unsupported private evidence format");
  const key = privateDecrypt({ key: recipient, oaepHash: "sha256" }, Buffer.from(envelope.key, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(envelope.body, "base64")), decipher.final()]).toString("utf8"),
  );
}

export async function sealDirectory(directory, recipient, destination) {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:json|out|log)$/.test(entry.name))
      files[entry.name] = (await readFile(path.join(directory, entry.name))).toString("base64");
  }
  if (!Object.keys(files).length) throw new Error("No native evidence files were produced");
  await writeFile(destination, sealEvidence(files, recipient));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, recipientFile, destination] = process.argv.slice(2);
  await sealDirectory(directory, await readFile(recipientFile, "utf8"), destination);
}
