import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashboard } from '../../src/services/dashboard-service.mjs';

test('dashboard deduplicates visitors and conversions across the same page-view population', () => {
  const createdAt = '2026-09-07T16:30:00.000Z';
  const events = [
    { visitorId: 'visitor-a', createdAt, page: '/', source: 'Direct' },
    {
      visitorId: 'visitor-a',
      createdAt,
      eventType: 'page_view',
      page: '/',
      source: 'Direct',
    },
    {
      visitorId: 'visitor-b',
      createdAt,
      eventType: 'page_view',
      page: '/privacy',
      source: 'Bing',
    },
    {
      visitorId: 'visitor-c',
      createdAt,
      eventType: 'page_view',
      page: '/',
      source: 'Direct',
    },
    { visitorId: 'bad', createdAt, eventType: 'page_view', page: '/' },
    { visitorId: 'visitor-a', createdAt, eventType: 'booking_success' },
    { visitorId: 'visitor-a', createdAt, eventType: 'booking_success' },
    { visitorId: 'visitor-unseen', createdAt, eventType: 'booking_success' },
    {
      visitorId: 'visitor-a',
      createdAt,
      eventType: 'image_open',
      targetId: 'photo',
      targetLabel: '测试图',
      section: 'outcomes',
    },
    {
      visitorId: 'visitor-a',
      createdAt,
      eventType: 'section_view',
      section: 'qualifications',
    },
  ];
  const dashboard = createDashboard(
    {
      events,
      inquiries: [
        { createdAt, analyticsAttributed: true },
        { createdAt, analyticsAttributed: false },
      ],
    },
    'Asia/Shanghai',
    Date.parse('2026-09-08T10:00:00.000Z'),
  );
  assert.deepEqual(dashboard.metrics, {
    visits: 5,
    visitors: 3,
    enquiries: 2,
    attributedEnquiries: 1,
    trackedConversions: 1,
    conversion: 33.3,
  });
  assert.equal(dashboard.daily.length, 7);
  assert.deepEqual(dashboard.daily[6], {
    date: '2026-09-08',
    visits: 5,
    visitors: 3,
    enquiries: 2,
    trackedConversions: 1,
  });
  assert.equal(dashboard.daily[0].date, '2026-09-02');
  assert.equal(dashboard.engagement.bookingSuccesses, 3);
  assert.equal(dashboard.engagement.qualificationViews, 1);
  assert.deepEqual(dashboard.engagement.topImages, [
    { id: 'photo', label: '测试图', section: 'outcomes', value: 1 },
  ]);
  assert.deepEqual(dashboard.pages[0], { label: '/', value: 4 });
});

test('empty and malformed dashboard collections return zero conversion and seven empty dates', () => {
  const dashboard = createDashboard(
    { events: null, inquiries: {} },
    'UTC',
    Date.parse('2026-09-08T10:00:00Z'),
  );
  assert.equal(dashboard.metrics.conversion, 0);
  assert.equal(dashboard.metrics.visitors, 0);
  assert.equal(dashboard.daily.length, 7);
  assert.equal(
    dashboard.daily.every(
      (day) => day.visits === 0 && day.trackedConversions === 0,
    ),
    true,
  );
});
