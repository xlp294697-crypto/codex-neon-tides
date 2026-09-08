export const timestamp = '2026-09-08T00:00:00.000Z';

export function inquiry(id, overrides = {}) {
  return {
    id,
    createdAt: timestamp,
    status: 'New',
    source: '',
    parentName: 'Synthetic Parent',
    phone: '00000000000',
    grade: '小学',
    course: '体态体能',
    concern: 'Synthetic inquiry',
    preferredTime: '',
    sourcePage: '',
    sourceSection: '',
    referrer: '',
    analyticsAttributed: false,
    privacyNoticeVersion: '2026-08-22',
    privacyConsentAt: timestamp,
    ...overrides,
  };
}

export function event(id, overrides = {}) {
  return {
    id,
    createdAt: timestamp,
    eventType: 'page_view',
    page: '/',
    visitorId: 'synthetic-visitor',
    section: '',
    targetId: '',
    targetLabel: '',
    referrer: '',
    source: '',
    medium: '',
    campaign: '',
    device: '',
    analyticsConsentAt: timestamp,
    analyticsNoticeVersion: '2026-08-22',
    ...overrides,
  };
}
