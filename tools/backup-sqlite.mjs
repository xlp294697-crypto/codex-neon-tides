import { chmod, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { parseArgs } from 'node:util';
import {
  backupName,
  backupTime,
  checkDatabase,
  cli,
  digestFile,
  durableWrite,
  fail,
  privateDirectory,
  regularFile,
  syncDirectory,
  syncFile,
} from './sqlite-operations.mjs';
import { verifyBackup } from './verify-backup.mjs';

export async function backupSqlite(
  source,
  directory,
  { retentionDays = 90, readOnly = true, prune = true } = {},
) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1)
    fail('RETENTION_INVALID');
  await regularFile(source);
  await privateDirectory(directory);
  const file = path.join(directory, backupName());
  const temporary = `${file}.partial`;
  await durableWrite(temporary, '');
  try {
    const db = new DatabaseSync(source, { readOnly });
    try {
      db.exec('PRAGMA busy_timeout=5000');
      await backup(db, temporary);
    } finally {
      db.close();
    }
    // Ensure the standalone snapshot cannot depend on WAL sidecars.
    const copy = new DatabaseSync(temporary);
    try {
      copy.exec('PRAGMA journal_mode=DELETE');
    } finally {
      copy.close();
    }
    await chmod(temporary, 0o600);
    await checkDatabase(temporary, { schemaMode: 'backup' });
    const digest = await digestFile(temporary);
    await syncFile(temporary);
    // The database name is the publication point. Complete and sync its
    // checksum first, so listing *.db can never select a half-published pair.
    await durableWrite(
      `${file}.sha256.txt`,
      `${digest}  ${path.basename(file)}\n`,
    );
    await syncDirectory(directory);
    await rename(temporary, file);
    await verifyBackup(file);
    await syncDirectory(directory);
    // Generated names only; safety/release backups use distinct directories.
    // Never remove the new recovery point, and never prune before verification.
    let removed = 0;
    if (!prune) return { file, removed };
    for (const name of await readdir(directory)) {
      if (
        Date.now() - backupTime(name) <= retentionDays * 86400000 ||
        !Number.isFinite(backupTime(name))
      )
        continue;
      const expired = path.join(directory, name);
      await regularFile(expired);
      await regularFile(`${expired}.sha256.txt`);
      await rm(expired);
      await rm(`${expired}.sha256.txt`);
      removed++;
    }
    return { file, removed };
  } finally {
    await rm(temporary, { force: true });
  }
}
await cli(import.meta.url, async () => {
  const { values } = parseArgs({
    options: {
      database: { type: 'string' },
      directory: { type: 'string' },
      'retention-days': {
        type: 'string',
        default: process.env.BACKUP_RETENTION_DAYS || '90',
      },
    },
  });
  if (!values.database || !values.directory) fail('ARGUMENTS_REQUIRED');
  const result = await backupSqlite(
    path.resolve(values.database),
    path.resolve(values.directory),
    { retentionDays: Number(values['retention-days']) },
  );
  return {
    code: 'BACKUP_CREATED',
    backup: path.basename(result.file),
    removed: result.removed,
  };
});
