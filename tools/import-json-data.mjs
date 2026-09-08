import { chmod, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/db/database.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { importJsonRecords } from '../src/repositories/json-import-repository.mjs';
import { normalizeReferrer } from '../src/validation/common.mjs';

function text(record, key, { optional = false } = {}) {
  const value = record[key];
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()))
    throw new Error('Invalid source field');
  return value;
}

function date(record, key) {
  const value = text(record, key);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error('Invalid source date');
  return new Date(value).toISOString();
}

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid source record');
  return value;
}

function normalizeSource(input) {
  record(input);
  if (
    input.version !== 1 ||
    !Array.isArray(input.inquiries) ||
    !Array.isArray(input.events)
  )
    throw new Error('Invalid source structure');
  const inquiries = input.inquiries.map((item) => {
    record(item);
    const status = text(item, 'status');
    if (!['New', 'Contacted', 'Qualified', 'Won', 'Closed'].includes(status))
      throw new Error('Invalid inquiry status');
    if (typeof item.analyticsAttributed !== 'boolean')
      throw new Error('Invalid attribution consent');
    const result = {
      id: text(item, 'id'),
      createdAt: date(item, 'createdAt'),
      status,
      parentName: text(item, 'parentName'),
      phone: text(item, 'phone'),
      grade: text(item, 'grade'),
      course: text(item, 'course'),
      concern: text(item, 'concern', { optional: true }),
      preferredTime: text(item, 'preferredTime', { optional: true }),
      analyticsAttributed: item.analyticsAttributed,
      privacyNoticeVersion: text(item, 'privacyNoticeVersion'),
      privacyConsentAt: date(item, 'privacyConsentAt'),
    };
    if (item.updatedAt !== undefined)
      result.updatedAt = date(item, 'updatedAt');
    for (const field of ['source', 'sourcePage', 'sourceSection', 'referrer']) {
      const value = text(item, field, { optional: true });
      result[field] = result.analyticsAttributed
        ? field === 'referrer'
          ? normalizeReferrer(value)
          : value
        : '';
    }
    return result;
  });
  const events = input.events.map((item) => {
    record(item);
    const eventType = text(item, 'eventType');
    if (
      ![
        'page_view',
        'section_view',
        'image_open',
        'assessment_click',
        'booking_success',
      ].includes(eventType)
    )
      throw new Error('Invalid event type');
    const result = {
      id: text(item, 'id'),
      createdAt: date(item, 'createdAt'),
      eventType,
      page: text(item, 'page'),
      visitorId: text(item, 'visitorId'),
      analyticsConsentAt: date(item, 'analyticsConsentAt'),
      analyticsNoticeVersion: text(item, 'analyticsNoticeVersion'),
    };
    for (const field of [
      'section',
      'targetId',
      'targetLabel',
      'referrer',
      'source',
      'medium',
      'campaign',
      'device',
    ]) {
      const value = text(item, field, { optional: true });
      result[field] = field === 'referrer' ? normalizeReferrer(value) : value;
    }
    return result;
  });
  return { inquiries, events };
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      database: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  if (!values.source || !values.database)
    throw new Error('Source and database required');
  const source = path.resolve(values.source);
  const destination = path.resolve(values.database);
  const sourceStat = await stat(source);
  let destinationStat;
  try {
    destinationStat = await stat(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (
    source === destination ||
    (destinationStat &&
      sourceStat.dev === destinationStat.dev &&
      sourceStat.ino === destinationStat.ino)
  )
    throw new Error('Source equals destination');
  const data = normalizeSource(JSON.parse(await readFile(source, 'utf8')));
  const dryRun = values['dry-run'];
  let db;
  let existingDb;
  try {
    if (dryRun) {
      if (destinationStat)
        existingDb = new DatabaseSync(destination, { readOnly: true });
      db = openDatabase(':memory:');
      migrate(db);
    } else {
      db = openDatabase(destination);
      if (process.platform !== 'win32') await chmod(destination, 0o600);
      migrate(db);
    }
    const result = importJsonRecords(db, data, {
      dryRun,
      existingDb: dryRun ? (existingDb ?? null) : db,
    });
    console.log(JSON.stringify(result));
  } finally {
    if (existingDb?.isOpen) existingDb.close();
    if (db?.isOpen) db.close();
  }
}

try {
  await main();
} catch {
  // Never print input fields, raw parser/SQLite errors, tokens, or source paths.
  console.error(
    'IMPORT_FAILED: verify arguments, source structure and database access.',
  );
  process.exitCode = 1;
}
