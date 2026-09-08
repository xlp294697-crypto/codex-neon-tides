import { createInquiryRepository } from './inquiry-repository.mjs';
import { createAnalyticsRepository } from './analytics-repository.mjs';
import { transaction } from './transaction.mjs';

// For dry runs db is disposable memory; existingDb is a read-only destination.
export function importJsonRecords(db, data, { existingDb = db, dryRun = false } = {}) {
  const inquiries = createInquiryRepository(db);
  const events = createAnalyticsRepository(db);
  const existingInquiries = existingDb ? createInquiryRepository(existingDb) : null;
  const existingEvents = existingDb ? createAnalyticsRepository(existingDb) : null;
  return transaction(db, () => {
    const result = { dryRun };
    for (const [kind, records, repository, existing] of [
      ['inquiries', data.inquiries, inquiries, existingInquiries],
      ['events', data.events, events, existingEvents],
    ]) {
      const counts = { source: records.length, imported: 0, skipped: 0 };
      const seen = new Set();
      for (const record of records) {
        if (seen.has(record.id) || existing?.has(record.id)) counts.skipped += 1;
        else {
          if (kind === 'inquiries') repository.create(record);
          else repository.insertBatch([record]);
          counts.imported += 1;
        }
        seen.add(record.id);
      }
      result[kind] = counts;
    }
    return result;
  });
}
