import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export class OperationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export function fail(code) {
  throw new OperationError(code);
}
export async function regularFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.nlink !== 1) fail('UNSAFE_FILE');
  return info;
}
export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_DIRECTORY');
  if (process.getuid && info.uid !== process.getuid()) fail('OWNER_MISMATCH');
  await chmod(directory, 0o700);
}
export async function digestFile(file) {
  await regularFile(file);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
export async function durableWrite(file, text) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function syncFile(file) {
  const handle = await open(file, process.platform === 'win32' ? 'r+' : 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  await syncFile(directory);
}
export function backupName() {
  return `jiuyue-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().replaceAll('-', '')}.db`;
}
export function backupTime(name) {
  const m =
    /^jiuyue-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-[a-f0-9]{32}\.db$/.exec(
      name,
    );
  return m
    ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`)
    : NaN;
}
export async function checkDatabase(file) {
  await regularFile(file);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const rows = db.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok')
      fail('SQLITE_INTEGRITY');
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      fail('SQLITE_FOREIGN_KEYS');
    const migrations = new URL('../src/db/migrations/', import.meta.url);
    const names = (await readdir(migrations))
      .filter((name) => /^\d+-[\w-]+\.sql$/.test(name))
      .sort();
    const history = db
      .prepare(
        'SELECT version, checksum FROM schema_migrations ORDER BY version',
      )
      .all();
    // Restoration is deliberately stricter than forward-compatible app startup.
    // Restore with the matching image; never silently migrate a recovery source.
    if (!names.length || history.length !== names.length)
      fail('MIGRATION_INCOMPATIBLE');
    for (let i = 0; i < names.length; i++) {
      const checksum = createHash('sha256')
        .update(await readFile(new URL(names[i], migrations)))
        .digest('hex');
      if (
        history[i].version !== Number(names[i].split('-')[0]) ||
        history[i].checksum !== checksum
      )
        fail('MIGRATION_INCOMPATIBLE');
    }
    for (const table of [
      'inquiries',
      'analytics_events',
      'admin_sessions',
      'audit_logs',
    ])
      db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    return { migrationVersion: history.at(-1).version };
  } finally {
    db.close();
  }
}
export async function cli(moduleUrl, action) {
  if (
    !process.argv[1] ||
    moduleUrl !== pathToFileURL(path.resolve(process.argv[1])).href
  )
    return;
  process.umask(0o077);
  try {
    console.log(JSON.stringify({ ok: true, ...(await action()) }));
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code: error instanceof OperationError ? error.code : 'OPERATION_FAILED',
      }),
    );
    process.exitCode = 1;
  }
}
