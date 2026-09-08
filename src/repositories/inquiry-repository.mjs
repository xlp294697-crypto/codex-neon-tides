import { createAuditRepository } from './audit-repository.mjs';
import { transaction } from './transaction.mjs';

const columns = [
  ['id', 'id'], ['created_at', 'createdAt'], ['updated_at', 'updatedAt'], ['status', 'status'],
  ['source', 'source'], ['parent_name', 'parentName'], ['phone', 'phone'], ['grade', 'grade'],
  ['course', 'course'], ['concern', 'concern'], ['preferred_time', 'preferredTime'],
  ['source_page', 'sourcePage'], ['source_section', 'sourceSection'], ['referrer', 'referrer'],
  ['analytics_attributed', 'analyticsAttributed'], ['privacy_notice_version', 'privacyNoticeVersion'],
  ['privacy_consent_at', 'privacyConsentAt'],
];

function fromRow(row) {
  return Object.fromEntries(columns.filter(([column]) => column !== 'updated_at' || row.updated_at !== null)
    .map(([column, field]) => [field, column === 'analytics_attributed' ? row[column] === 1 : row[column]]));
}

export function createInquiryRepository(db) {
  const insert = db.prepare(`INSERT INTO inquiries (${columns.map(([column]) => column).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
  const all = db.prepare('SELECT * FROM inquiries ORDER BY created_at DESC, rowid DESC');
  const find = db.prepare('SELECT status FROM inquiries WHERE id = ?');
  const update = db.prepare('UPDATE inquiries SET status = ?, updated_at = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM inquiries WHERE id = ?');
  const overflow = db.prepare('SELECT id FROM inquiries ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?');
  const audit = createAuditRepository(db);
  const repository = {
    create(record) {
      const values = columns.map(([, field]) => field === 'updatedAt' ? record[field] ?? null
        : field === 'analyticsAttributed' ? (record[field] === true ? 1 : 0) : record[field]);
      insert.run(...values);
      return record;
    },
    has(id) { return Boolean(find.get(id)); },
    findAll() { return all.all().map(fromRow); },
    updateStatus(id, status, updatedAt) {
      if (!['New', 'Contacted', 'Qualified', 'Won', 'Closed'].includes(status)) throw new Error('Invalid inquiry status');
      return transaction(db, () => {
        const previous = find.get(id);
        if (!previous) return false;
        update.run(status, updatedAt, id);
        audit.create({ action: 'inquiry_status_changed', inquiryId: id, createdAt: updatedAt, payload: { fromStatus: previous.status, toStatus: status } });
        return true;
      });
    },
    remove(id) {
      return transaction(db, () => {
        if (!remove.run(id).changes) return false;
        audit.create({ action: 'inquiry_deleted', inquiryId: id });
        return true;
      });
    },
    prune(maxRecords) {
      if (!Number.isSafeInteger(maxRecords) || maxRecords < 0) throw new Error('Invalid inquiry record limit');
      return transaction(db, () => {
        const records = overflow.all(maxRecords);
        for (const { id } of records) repository.remove(id);
        return records.length;
      });
    },
  };
  return repository;
}
