import { ajv, getText, getSource, normalizeReferrer, readAnalyticsConsent } from './common.mjs';

// Normalize using the existing public contract before applying the request schema.
// Coercion, truncation and unknown-field handling therefore remain unchanged.
const inquirySchema = ajv.compile({
  type: 'object',
  required: ['parentName', 'phone', 'grade', 'course', 'privacyConsent'],
  properties: {
    parentName: { type: 'string', minLength: 1, maxLength: 100 },
    phone: { type: 'string', pattern: '^\\+?[0-9][0-9\\s-]{5,29}$' },
    grade: { type: 'string', minLength: 1, maxLength: 80 },
    course: { type: 'string', minLength: 1, maxLength: 100 },
    concern: { type: 'string', maxLength: 2000 },
    preferredTime: { type: 'string', maxLength: 100 },
    sourcePage: { type: 'string', maxLength: 160 },
    sourceSection: { type: 'string', maxLength: 80 },
    referrer: { type: 'string', maxLength: 250 },
    privacyConsent: { const: true },
    source: { type: 'string', maxLength: 40 },
    analyticsAttributed: { type: 'boolean' },
  },
  additionalProperties: false,
});

export function validateInquiry(input, options) {
  const body = input ?? {};
  const consent = readAnalyticsConsent(body, options);
  const value = {
    parentName: getText(body.parentName, 100),
    phone: getText(body.phone, 40),
    grade: getText(body.grade, 80),
    course: getText(body.course, 100),
    concern: getText(body.concern, 2000),
    preferredTime: getText(body.preferredTime, 100),
    sourcePage: consent ? getText(body.sourcePage, 160) : '',
    sourceSection: consent ? getText(body.sourceSection, 80) : '',
    referrer: consent ? normalizeReferrer(body.referrer) : '',
    privacyConsent: body.privacyConsent === true || body.privacyConsent === 'yes',
    source: consent ? getSource(body) : '',
    analyticsAttributed: Boolean(consent),
  };
  if (!inquirySchema(value)) {
    if (inquirySchema.errors.some((error) => error.instancePath !== '/privacyConsent')) {
      return { ok: false, code: 'INVALID_INQUIRY', message: '请填写家长姓名、有效电话、孩子年级和意向课程。' };
    }
    return { ok: false, code: 'PRIVACY_CONSENT_REQUIRED', message: '请先确认预约信息处理告知。' };
  }
  return { ok: true, value };
}
