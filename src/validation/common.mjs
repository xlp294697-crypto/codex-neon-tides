import Ajv from 'ajv';

export const ajv = new Ajv({ allErrors: true });
const ANALYTICS_NOTICE_VERSION = '2026-08-22';
const consentSchema = ajv.compile({
  type: 'object',
  required: ['analyticsConsent', 'analyticsNoticeVersion'],
  properties: {
    analyticsConsent: { const: true },
    analyticsNoticeVersion: { const: ANALYTICS_NOTICE_VERSION },
  },
});

export function getText(value, maximum = 500) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, maximum);
}

export function getSource(input) {
  const source = normalizeCampaignValue(input?.utm?.source, 40);
  if (source) return source;
  const referrer = normalizeReferrer(input?.referrer).toLowerCase();
  if (referrer.includes('google')) return 'Google';
  if (referrer.includes('bing')) return 'Bing';
  if (referrer) return 'Referral';
  return 'Direct';
}

export function normalizeCampaignValue(value, maximum) {
  return getText(value, maximum * 2)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maximum);
}

export function normalizeReferrer(value) {
  const raw = getText(value, 500);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.origin.slice(0, 250);
  } catch {
    return '';
  }
}

export function normalizeVisitorId(value) {
  const visitorId = getText(value, 100);
  return /^[A-Za-z0-9_-]{8,100}$/.test(visitorId) ? visitorId : '';
}

export function readAnalyticsConsent(body, { now = Date.now() } = {}) {
  if (!consentSchema(body))
    return null;
  const consentAt = getText(body.analyticsConsentAt, 40);
  const timestamp = Date.parse(consentAt);
  if (!Number.isFinite(timestamp) || timestamp > now + 86400000)
    return null;
  return {
    analyticsConsentAt: new Date(timestamp).toISOString(),
    analyticsNoticeVersion: ANALYTICS_NOTICE_VERSION,
  };
}
