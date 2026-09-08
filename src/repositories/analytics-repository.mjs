import { transaction } from './transaction.mjs';

const columns = [
  ['id', 'id'], ['created_at', 'createdAt'], ['event_type', 'eventType'], ['page', 'page'],
  ['visitor_id', 'visitorId'], ['section', 'section'], ['target_id', 'targetId'], ['target_label', 'targetLabel'],
  ['referrer', 'referrer'], ['source', 'source'], ['medium', 'medium'], ['campaign', 'campaign'],
  ['device', 'device'], ['analytics_consent_at', 'analyticsConsentAt'], ['analytics_notice_version', 'analyticsNoticeVersion'],
];

export function createAnalyticsRepository(db) {
  const insert = db.prepare(`INSERT INTO analytics_events (${columns.map(([column]) => column).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
  const all = db.prepare('SELECT * FROM analytics_events ORDER BY created_at, rowid');
  const find = db.prepare('SELECT id FROM analytics_events WHERE id = ?');
  const expired = db.prepare('DELETE FROM analytics_events WHERE created_at < ?');
  const overflow = db.prepare('DELETE FROM analytics_events WHERE id IN (SELECT id FROM analytics_events ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)');
  return {
    has(id) { return Boolean(find.get(id)); },
    insertBatch(events) {
      return transaction(db, () => {
        for (const record of events) insert.run(...columns.map(([, field]) => record[field]));
        return events.length;
      });
    },
    findAll() { return all.all().map((row) => Object.fromEntries(columns.map(([column, field]) => [field, row[column]]))); },
    prune({ cutoff, maxRecords }) {
      if (!Number.isFinite(Date.parse(cutoff)) || !Number.isSafeInteger(maxRecords) || maxRecords < 0) throw new Error('Invalid event retention options');
      return transaction(db, () => Number(expired.run(cutoff).changes) + Number(overflow.run(maxRecords).changes));
    },
  };
}
