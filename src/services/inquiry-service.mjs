import { randomUUID } from 'node:crypto';

const missingInquiry = () => ({ ok: false, code: 'INQUIRY_NOT_FOUND', message: '没有找到该预约。' });

// Repository: create(record), findAll(), updateStatus(id, status, updatedAt), remove(id).
// Writes resolve only after persistence; update/remove report whether the ID existed.
export function createInquiryService(repository) {
  async function create(value) {
    const inquiry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'New',
      source: value.source,
      parentName: value.parentName,
      phone: value.phone,
      grade: value.grade,
      course: value.course,
      concern: value.concern,
      preferredTime: value.preferredTime,
      sourcePage: value.sourcePage,
      sourceSection: value.sourceSection,
      referrer: value.referrer,
      analyticsAttributed: value.analyticsAttributed,
      privacyNoticeVersion: '2026-08-22',
      privacyConsentAt: new Date().toISOString(),
    };
    await repository.create(inquiry);
    return inquiry;
  }

  async function updateStatus(id, status) {
    if (!['New', 'Contacted', 'Qualified', 'Won', 'Closed'].includes(status)) {
      return { ok: false, code: 'INVALID_INQUIRY_STATUS', message: '预约状态无效。' };
    }
    const changed = await repository.updateStatus(id, status, new Date().toISOString());
    return changed ? { ok: true } : missingInquiry();
  }

  async function remove(id) {
    return await repository.remove(id) ? { ok: true } : missingInquiry();
  }

  return { create, findAll: () => repository.findAll(), updateStatus, remove };
}
