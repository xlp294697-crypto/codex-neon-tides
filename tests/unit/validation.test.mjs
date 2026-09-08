import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInquiry } from '../../src/validation/inquiries.mjs';
import { validateEvent } from '../../src/validation/events.mjs';

const now = Date.parse('2026-09-08T12:00:00.000Z');
const consent = {
  analyticsConsent: true,
  analyticsNoticeVersion: '2026-08-22',
  analyticsConsentAt: '2026-09-08T11:00:00Z',
};
const inquiry = {
  parentName: '虚构家长',
  phone: '000-000',
  grade: '测试年级',
  course: '测试课程',
  privacyConsent: true,
};
const event = { page: '/', visitorId: 'visitor-test', ...consent };

test('missing phone keeps the required inquiry fields error ahead of privacy consent', () => {
  assert.deepEqual(
    validateInquiry({ ...inquiry, phone: '', privacyConsent: false }),
    {
      ok: false,
      code: 'INVALID_INQUIRY',
      message: '请填写家长姓名、有效电话、孩子年级和意向课程。',
    },
  );
});

test('valid inquiry fields still require independent privacy consent', () => {
  assert.deepEqual(validateInquiry({ ...inquiry, privacyConsent: false }), {
    ok: false,
    code: 'PRIVACY_CONSENT_REQUIRED',
    message: '请先确认预约信息处理告知。',
  });
});

test('valid inquiry normalizes legacy field values without adding visitor attribution', () => {
  const result = validateInquiry({
    ...inquiry,
    parentName: ' 虚构家长 ',
    grade: 7,
    privacyConsent: 'yes',
    visitorId: 'visitor-test',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.parentName, '虚构家长');
  assert.equal(result.value.grade, '7');
  assert.equal(result.value.privacyConsent, true);
  assert.equal(result.value.analyticsAttributed, false);
  assert.equal('visitorId' in result.value, false);
});

for (const [label, invalid] of [
  ['invalid notice version', { analyticsNoticeVersion: 'obsolete' }],
  ['future consent time', { analyticsConsentAt: '2026-09-09T12:00:00.001Z' }],
  ['invalid consent time', { analyticsConsentAt: 'invalid' }],
  ['nonboolean consent', { analyticsConsent: 'true' }],
]) {
  test(`${label} rejects events and strips inquiry attribution without rejecting the appointment`, () => {
    assert.deepEqual(validateEvent({ ...event, ...invalid }, { now }), {
      ok: false,
      code: 'INVALID_ANALYTICS_CONSENT',
      message: '缺少有效的访问统计同意记录。',
    });
    const result = validateInquiry(
      {
        ...inquiry,
        ...consent,
        ...invalid,
        sourcePage: '/private',
        sourceSection: 'assessment',
        referrer: 'https://ref.example/private?secret=value',
        utm: { source: 'campaign' },
      },
      { now },
    );
    assert.equal(result.ok, true);
    assert.equal(result.value.analyticsAttributed, false);
    for (const field of ['source', 'sourcePage', 'sourceSection', 'referrer'])
      assert.equal(result.value[field], '');
  });
}

test('consent at the one-day future tolerance is accepted and attribution is sanitized', () => {
  const result = validateInquiry(
    {
      ...inquiry,
      ...consent,
      analyticsConsentAt: '2026-09-09T12:00:00.000Z',
      sourcePage: ' / ',
      sourceSection: ' assessment ',
      referrer: 'https://ref.example/private?secret=value',
      utm: { source: ' 测试 campaign! ' },
    },
    { now },
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.analyticsAttributed, true);
  assert.equal(result.value.source, '测试-campaign');
  assert.equal(result.value.referrer, 'https://ref.example');
  assert.equal(result.value.sourcePage, '/');
});

test('valid events preserve defaults, field limits and campaign/referrer normalization', () => {
  const result = validateEvent(
    {
      ...event,
      eventType: ' PAGE_VIEW ',
      section: 'x'.repeat(90),
      referrer: 'https://www.google.com/search?q=private',
      utm: { medium: ' paid social ', campaign: 'ＡＢＣ' },
    },
    { now },
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.eventType, 'page_view');
  assert.equal(result.value.section.length, 80);
  assert.equal(result.value.referrer, 'https://www.google.com');
  assert.equal(result.value.source, 'Google');
  assert.equal(result.value.medium, 'paid-social');
  assert.equal(result.value.campaign, 'ABC');
  assert.equal(result.value.analyticsConsentAt, '2026-09-08T11:00:00.000Z');
  assert.equal(validateEvent(event, { now }).value.eventType, 'page_view');
});

for (const [input, code, message] of [
  [
    { eventType: 'unknown', page: '' },
    'UNSUPPORTED_EVENT_TYPE',
    '不支持的统计事件类型。',
  ],
  [{ page: '' }, 'INVALID_EVENT_IDENTITY', '缺少页面或随机访客标识。'],
  [
    { visitorId: 'short' },
    'INVALID_EVENT_IDENTITY',
    '缺少页面或随机访客标识。',
  ],
  [
    { eventType: 'section_view', section: 'other' },
    'INVALID_EVENT_SECTION',
    '区块浏览事件缺少有效区块。',
  ],
  [
    { eventType: 'image_open', targetId: 'image' },
    'INVALID_EVENT_IMAGE',
    '图片打开事件缺少图片标识。',
  ],
  [
    { eventType: 'assessment_click' },
    'INVALID_EVENT_SECTION',
    '预约按钮事件缺少来源区块。',
  ],
]) {
  test(`event validation maps ${code}: ${JSON.stringify(input)}`, () => {
    assert.deepEqual(validateEvent({ ...event, ...input }, { now }), {
      ok: false,
      code,
      message,
    });
  });
}
