import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

// Conservative expansion grammar: no data rewrites, triggers, unique indexes,
// renames, drops, new constraints on existing columns, or arbitrary SQL.
export function assertExpandMigration(sql) {
  const normalized = sql.replace(
    /'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g,
    (value) => (value.startsWith("'") ? "''" : ' '),
  );
  const statements = normalized
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!statements.length) throw new Error('Empty migration');
  for (const statement of statements) {
    const allowed =
      /^CREATE\s+TABLE\s+[a-z_][a-z0-9_]*\s*\([\s\S]*\)(?:\s+STRICT)?$/i.test(
        statement,
      ) ||
      /^CREATE\s+INDEX\s+[a-z_][a-z0-9_]*\s+ON\s+[a-z_][a-z0-9_]*\s*\([a-z0-9_,\s]+\)$/i.test(
        statement,
      ) ||
      /^ALTER\s+TABLE\s+[a-z_][a-z0-9_]*\s+ADD\s+(?:COLUMN\s+)?[a-z_][a-z0-9_]*\s+(?:TEXT|INTEGER|REAL|BLOB)$/i.test(
        statement,
      );
    if (
      !allowed ||
      /\b(?:DROP|DELETE|UPDATE|REPLACE|ATTACH|DETACH|PRAGMA|TRIGGER|RENAME)\b/i.test(
        statement,
      )
    )
      throw new Error('Migration requires separate review');
  }
}

export async function backupDatabase(source, target) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  // Exclusive reservation: never overwrite an earlier recovery point.
  writeFileSync(target, '', { flag: 'wx', mode: 0o600 });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, target);
  } finally {
    db.close();
  }
  chmodSync(target, 0o600);
  const standalone = new DatabaseSync(target);
  try {
    standalone.exec('PRAGMA journal_mode = DELETE');
  } finally {
    standalone.close();
  }
  const copy = new DatabaseSync(target, { readOnly: true });
  try {
    const integrity = copy.prepare('PRAGMA integrity_check').all();
    if (
      integrity.length !== 1 ||
      Object.values(integrity[0])[0] !== 'ok' ||
      copy.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('Backup verification failed');
    copy.prepare('SELECT version FROM schema_migrations').all();
  } finally {
    copy.close();
  }
  const digest = createHash('sha256')
    .update(readFileSync(target))
    .digest('hex');
  writeFileSync(`${target}.sha256`, `${digest}\n`, { flag: 'wx', mode: 0o600 });
  // Keep the legacy digest for existing release consumers, and provide the
  // portable sidecar consumed by the shared guarded recovery tools.
  writeFileSync(
    `${target}.sha256.txt`,
    `${digest}  ${path.basename(target)}\n`,
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
  if (
    createHash('sha256').update(readFileSync(target)).digest('hex') !==
    readFileSync(`${target}.sha256`, 'utf8').trim()
  )
    throw new Error('Backup checksum mismatch');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let db;
  try {
    if (process.argv[2] === 'backup') {
      await backupDatabase(
        process.env.DATA_PATH || '/app/data/site.db',
        process.argv[3],
      );
    } else if (process.argv[2] === 'migrate') {
      const { openDatabase } = await import(
        pathToFileURL(path.resolve('src/db/database.mjs'))
      );
      const { migrate } = await import(
        pathToFileURL(path.resolve('src/db/migrate.mjs'))
      );
      db = openDatabase(process.env.DATA_PATH || '/app/data/site.db');
      const hasHistory = db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'schema_migrations'",
        )
        .get();
      const version = migrate(db, {
        validatePending(migration) {
          if (hasHistory && process.env.ROLLBACK_SCHEMA_COMPATIBLE !== '1')
            throw new Error(
              'Previous image lacks forward schema compatibility',
            );
          assertExpandMigration(migration.sql);
        },
      });
      console.log(`Migration version: ${version}`);
    } else throw new Error('Invalid database release command');
  } catch {
    console.error('Release database check failed.');
    process.exitCode = 1;
  } finally {
    if (db?.isOpen) db.close();
  }
}
