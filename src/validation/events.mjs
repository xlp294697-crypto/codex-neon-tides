import {
  ajv,
  getText,
  getSource,
  normalizeCampaignValue,
  normalizeReferrer,
  normalizeVisitorId,
  readAnalyticsConsent,
} from './common.mjs';

const eventSchema = ajv.compile({
  type: 'object',
  required: ['eventType', 'page', 'visitorId'],
  properties: {
    eventType: {
      enum: [
        'page_view',
        'section_view',
        'image_open',
        'assessment_click',
        'booking_success',
      ],
    },
    page: { type: 'string', minLength: 1, maxLength: 160 },
    visitorId: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,100}$' },
    section: { type: 'string', maxLength: 80 },
    targetId: { type: 'string', maxLength: 120 },
    targetLabel: { type: 'string', maxLength: 250 },
    referrer: { type: 'string', maxLength: 250 },
    source: { type: 'string', maxLength: 40 },
    medium: { type: 'string', maxLength: 40 },
    campaign: { type: 'string', maxLength: 80 },
    device: { type: 'string', maxLength: 30 },
    analyticsConsentAt: { type: 'string' },
    analyticsNoticeVersion: { const: '2026-08-22' },
  },
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { eventType: { const: 'section_view' } } },
      then: {
        properties: { section: { enum: ['qualifications', 'outcomes'] } },
      },
    },
    {
      if: { properties: { eventType: { const: 'image_open' } } },
      then: {
        properties: {
          targetId: { type: 'string', minLength: 1 },
          targetLabel: { type: 'string', minLength: 1 },
        },
      },
    },
    {
      if: { properties: { eventType: { const: 'assessment_click' } } },
      then: { properties: { section: { type: 'string', minLength: 1 } } },
    },
  ],
});

export function validateEvent(input, options) {
  const body = input ?? {};
  const consent = readAnalyticsConsent(body, options);
  if (!consent)
    return {
      ok: false,
      code: 'INVALID_ANALYTICS_CONSENT',
      message: '缺少有效的访问统计同意记录。',
    };
  const value = {
    eventType: getText(body.eventType || 'page_view', 40).toLowerCase(),
    page: getText(body.page, 160),
    visitorId: normalizeVisitorId(body.visitorId),
    section: getText(body.section, 80),
    targetId: getText(body.targetId, 120),
    targetLabel: getText(body.targetLabel, 250),
    referrer: normalizeReferrer(body.referrer),
    source: getSource(body),
    medium: normalizeCampaignValue(body?.utm?.medium, 40),
    campaign: normalizeCampaignValue(body?.utm?.campaign, 80),
    device: getText(body.device, 30),
    ...consent,
  };
  if (!eventSchema(value)) {
    const paths = new Set(
      eventSchema.errors.map((error) => error.instancePath),
    );
    if (paths.has('/eventType'))
      return {
        ok: false,
        code: 'UNSUPPORTED_EVENT_TYPE',
        message: '不支持的统计事件类型。',
      };
    if (paths.has('/page') || paths.has('/visitorId'))
      return {
        ok: false,
        code: 'INVALID_EVENT_IDENTITY',
        message: '缺少页面或随机访客标识。',
      };
    if (value.eventType === 'section_view')
      return {
        ok: false,
        code: 'INVALID_EVENT_SECTION',
        message: '区块浏览事件缺少有效区块。',
      };
    if (value.eventType === 'image_open')
      return {
        ok: false,
        code: 'INVALID_EVENT_IMAGE',
        message: '图片打开事件缺少图片标识。',
      };
    return {
      ok: false,
      code: 'INVALID_EVENT_SECTION',
      message: '预约按钮事件缺少来源区块。',
    };
  }
  return { ok: true, value };
}
