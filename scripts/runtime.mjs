import { readFile, writeFile, mkdir, cp, chmod, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { unzipSync } from 'fflate';
const lock = JSON.parse(await readFile('runtime-lock.json', 'utf8'));
export async function provision(target) {
  const archive = lock.archives[target];
  if (!archive) throw new Error(`Unsupported platform ${target}`);
  const dir = path.resolve('.cache/runtimes', target);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, archive.file);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    const response = await fetch(`https://nodejs.org/dist/${lock.version}/${archive.file}`);
    if (!response.ok) throw new Error(`Runtime download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(file, bytes);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== archive.sha256)
    throw new Error('Runtime checksum mismatch');
  const prefix = archive.file.replace(/\.(tar\.xz|zip)$/, '');
  const extracted = path.join(dir, prefix),
    out = path.resolve('dist/runtime', target);
  await mkdir(out, { recursive: true });
  const binary = target.startsWith('win32-') ? 'node.exe' : 'node';
  if (archive.file.endsWith('.zip')) {
    const needed = new Set([prefix + '/node.exe', prefix + '/LICENSE']);
    const files = unzipSync(bytes, { filter: (entry) => needed.has(entry.name) });
    await writeFile(path.join(out, binary), files[prefix + '/node.exe']);
    await writeFile(path.join(out, 'NODE-LICENSE'), files[prefix + '/LICENSE']);
  } else {
    execFileSync('tar', ['-xf', file, '-C', dir, prefix + '/bin/node', prefix + '/LICENSE']);
    await cp(path.join(extracted, 'bin/node'), path.join(out, binary));
    await cp(path.join(extracted, 'LICENSE'), path.join(out, 'NODE-LICENSE'));
  }
  await chmod(path.join(out, binary), 0o755);
  await writeFile(
    path.join(out, 'provenance.json'),
    JSON.stringify(
      {
        version: lock.version,
        archive: archive.file,
        archiveSha256: archive.sha256,
        binarySha256: createHash('sha256')
          .update(await readFile(path.join(out, binary)))
          .digest('hex'),
      },
      null,
      2,
    ),
  );
  return out;
}
if (process.argv[1]?.endsWith('runtime.mjs'))
  for (const target of process.argv.includes('--all')
    ? Object.keys(lock.archives)
    : [process.argv[2] ?? `${process.platform}-${process.arch}`]) {
    console.log(`Preparing Node ${lock.version} for ${target}`);
    await provision(target);
  }
