import { randomUUID } from 'node:crypto';

export function createAuditRepository(db) {
  const insert = db.prepare(
    'INSERT INTO audit_logs (id, created_at, action, inquiry_id, payload) VALUES (?, ?, ?, ?, ?)',
  );
  const all = db.prepare(
    'SELECT * FROM audit_logs ORDER BY created_at DESC, rowid DESC',
  );
  return {
    create({
      id = randomUUID(),
      createdAt = new Date().toISOString(),
      action,
      inquiryId,
      payload = {},
    }) {
      insert.run(id, createdAt, action, inquiryId, JSON.stringify(payload));
    },
    findAll() {
      return all.all().map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        action: row.action,
        inquiryId: row.inquiry_id,
        payload: JSON.parse(row.payload),
      }));
    },
  };
}
