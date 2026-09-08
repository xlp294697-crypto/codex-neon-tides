import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

const migrationsDirectory = new URL('./migrations/', import.meta.url);

function readMigrations() {
  let previousVersion = 0;
  return readdirSync(migrationsDirectory)
    .filter((name) => /^\d+-[\w-]+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const version = Number(name.slice(0, name.indexOf('-')));
      if (!Number.isSafeInteger(version) || version <= previousVersion) {
        throw new Error(`Duplicate or out-of-order migration version: ${name}`);
      }
      previousVersion = version;
      const bytes = readFileSync(new URL(name, migrationsDirectory));
      return { version, sql: bytes.toString('utf8'), checksum: createHash('sha256').update(bytes).digest('hex') };
    });
}

// Lock before reading history so competing starters cannot apply a version twice.
// One transaction covers all pending SQL and its history, including first startup.
export function migrate(db) {
  const migrations = readMigrations();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
      applied_at TEXT NOT NULL
    ) STRICT`);
    const applied = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
    for (const recorded of applied) {
      const migration = migrations.find((item) => item.version === recorded.version);
      if (!migration) throw new Error(`Missing applied migration version ${recorded.version}`);
      if (migration.checksum !== recorded.checksum) {
        throw new Error(`Migration checksum mismatch for version ${recorded.version}`);
      }
    }
    let version = applied.at(-1)?.version ?? 0;
    const appliedVersions = new Set(applied.map((item) => item.version));
    const record = db.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)');
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      if (migration.version <= version) throw new Error(`Out-of-order migration version ${migration.version}`);
      db.exec(migration.sql);
      record.run(migration.version, migration.checksum, new Date().toISOString());
      version = migration.version;
    }
    db.exec('COMMIT');
    return version;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
