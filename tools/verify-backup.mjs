import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  checkDatabase,
  cli,
  digestFile,
  fail,
  regularFile,
} from './sqlite-operations.mjs';

export async function verifyBackup(file) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      await lstat(`${file}${suffix}`);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    fail('BACKUP_NOT_STANDALONE');
  }
  await regularFile(`${file}.sha256.txt`);
  const sidecar = await readFile(`${file}.sha256.txt`, 'utf8');
  const match = /^([a-f0-9]{64}) {2}([^\r\n/\\]+)\n$/.exec(sidecar);
  if (
    !match ||
    match[2] !== path.basename(file) ||
    (await digestFile(file)) !== match[1]
  )
    fail('BACKUP_HASH_MISMATCH');
  return checkDatabase(file);
}
await cli(import.meta.url, async () => {
  const { values } = parseArgs({ options: { backup: { type: 'string' } } });
  if (!values.backup) fail('ARGUMENTS_REQUIRED');
  return {
    code: 'BACKUP_VERIFIED',
    ...(await verifyBackup(path.resolve(values.backup))),
  };
});
