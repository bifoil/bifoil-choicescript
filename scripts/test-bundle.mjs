import { execFileSync } from 'node:child_process';
import path from 'node:path';
const node = path.resolve(
  'dist/runtime',
  process.platform + '-' + process.arch,
  process.platform === 'win32' ? 'node.exe' : 'node',
);
execFileSync(node, ['scripts/smoke-bundle.cjs'], { stdio: 'inherit' });
