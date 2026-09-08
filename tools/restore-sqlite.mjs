import { chmod, copyFile, lstat, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { backupSqlite } from './backup-sqlite.mjs';
import { verifyBackup } from './verify-backup.mjs';
import {
  backupName,
  cli,
  durableWrite,
  fail,
  privateDirectory,
  regularFile,
  syncFile,
  syncDirectory,
} from './sqlite-operations.mjs';

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}
export async function restoreSqlite({
  source,
  target,
  appStopped,
  confirmTarget,
}) {
  if (!appStopped || confirmTarget !== target)
    fail('RESTORE_CONFIRMATION_REQUIRED');
  if (source === target) fail('RESTORE_SAME_PATH');
  // This is an operator attestation, not a process detector. Stop every writer
  // and keep it stopped throughout; sidecars are an additional fail-closed guard.
  for (const suffix of ['-wal', '-shm', '-journal'])
    if (await exists(`${target}${suffix}`)) fail('DATABASE_NOT_QUIESCENT');
  await verifyBackup(source);
  const directory = path.dirname(target);
  await privateDirectory(directory);
  const lock = `${target}.restore-lock`;
  await durableWrite(lock, 'restore in progress\n');
  const temporary = path.join(directory, `${backupName()}.restore-partial`);
  try {
    let safety;
    if (await exists(target)) {
      const info = await regularFile(target);
      if (process.getuid && info.uid !== process.getuid())
        fail('OWNER_MISMATCH');
      safety = await backupSqlite(
        target,
        path.join(directory, 'pre-restore-backups'),
        { prune: false, readOnly: false },
      );
    }
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, 0o600);
    // Verify the exact bytes which will replace the target, including a source
    // changed between its first verification and copying.
    const { readFile } = await import('node:fs/promises');
    const sidecar = await readFile(`${source}.sha256.txt`, 'utf8');
    await durableWrite(
      `${temporary}.sha256.txt`,
      sidecar.replace(
        `  ${path.basename(source)}\n`,
        `  ${path.basename(temporary)}\n`,
      ),
    );
    await verifyBackup(temporary);
    await syncFile(temporary);
    for (const suffix of ['-wal', '-shm', '-journal'])
      if (await exists(`${target}${suffix}`)) fail('DATABASE_NOT_QUIESCENT');
    await rename(temporary, target);
    await syncDirectory(directory);
    return {
      code: 'DATABASE_RESTORED',
      safetyBackup: safety ? path.basename(safety.file) : null,
    };
  } finally {
    await rm(temporary, { force: true });
    await rm(`${temporary}.sha256.txt`, { force: true });
    await rm(lock, { force: true });
  }
}
await cli(import.meta.url, async () => {
  const { values } = parseArgs({
    options: {
      backup: { type: 'string' },
      database: { type: 'string' },
      'app-stopped': { type: 'boolean', default: false },
      'confirm-target': { type: 'string' },
    },
  });
  if (!values.backup || !values.database) fail('ARGUMENTS_REQUIRED');
  return restoreSqlite({
    source: path.resolve(values.backup),
    target: path.resolve(values.database),
    appStopped: values['app-stopped'],
    confirmTarget: values['confirm-target'],
  });
});
