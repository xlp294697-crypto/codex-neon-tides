import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertSupportedNodeVersion(version) {
  const major = Number(String(version).split('.')[0]);
  if (!Number.isSafeInteger(major) || major < 24)
    throw new Error('Jiuyue Sports requires Node.js 24 or newer.');
}

const isEntry =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  try {
    assertSupportedNodeVersion(process.versions.node);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
