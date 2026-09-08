import test from 'node:test';
import assert from 'node:assert/strict';
import { createInquiryService } from '../../src/services/inquiry-service.mjs';
import { createAnalyticsService } from '../../src/services/analytics-service.mjs';
import { validateInquiry } from '../../src/validation/inquiries.mjs';
import { validateEvent } from '../../src/validation/events.mjs';

test('inquiry service persists only normalized appointment data and supports status and removal outcomes', async () => {
  const records = [];
  const repository = {
    async create(record) {
      records.unshift(record);
    },
    async findAll() {
      return records;
    },
    async updateStatus(id, status, updatedAt) {
      const record = records.find((item) => item.id === id);
      if (!record) return false;
      Object.assign(record, { status, updatedAt });
      return true;
    },
    async remove(id) {
      const index = records.findIndex((item) => item.id === id);
      if (index < 0) return false;
      records.splice(index, 1);
      return true;
    },
  };
  const service = createInquiryService(repository);
  const value = validateInquiry({
    parentName: '虚构家长',
    phone: '000-000',
    grade: '测试年级',
    course: '测试课程',
    privacyConsent: true,
    visitorId: 'visitor-sensitive',
    ip: 'do-not-store',
  }).value;
  const record = await service.create(value);
  assert.equal((await service.findAll()).length, 1);
  assert.equal(records[0].status, 'New');
  assert.equal(records[0].analyticsAttributed, false);
  assert.equal(records[0].privacyNoticeVersion, '2026-08-22');
  assert.equal(Number.isFinite(Date.parse(record.privacyConsentAt)), true);
  for (const field of ['privacyConsent', 'ip', 'visitorId'])
    assert.equal(field in records[0], false);
  assert.deepEqual(await service.updateStatus(record.id, 'invalid'), {
    ok: false,
    code: 'INVALID_INQUIRY_STATUS',
    message: '预约状态无效。',
  });
  assert.equal(records[0].status, 'New');
  assert.deepEqual(await service.updateStatus(record.id, 'Contacted'), {
    ok: true,
  });
  assert.equal(records[0].status, 'Contacted');
  assert.equal(Number.isFinite(Date.parse(records[0].updatedAt)), true);
  assert.deepEqual(await service.remove(record.id), { ok: true });
  assert.equal(records.length, 0);
  const missing = {
    ok: false,
    code: 'INQUIRY_NOT_FOUND',
    message: '没有找到该预约。',
  };
  assert.deepEqual(await service.remove(record.id), missing);
  assert.deepEqual(await service.updateStatus(record.id, 'Won'), missing);
});

test('failed inquiry persistence rejects creation instead of reporting success', async () => {
  const service = createInquiryService({
    create() {
      throw new Error('unavailable');
    },
  });
  await assert.rejects(service.create({}), /unavailable/);
});

test('analytics service requeues failed batches and drains them once without losing event identity', async () => {
  const stored = [];
  const delays = [];
  let fail = true;
  let unhealthy = false;
  const service = createAnalyticsService(
    {
      async insertBatch(batch) {
        if (fail) throw new Error('unavailable');
        stored.push(...batch);
      },
    },
    {
      onWriteFailure() {
        unhealthy = true;
      },
    },
  );
  service.setEventTimerControls({
    schedule(delay) {
      delays.push(delay);
    },
    cancel() {},
  });
  const value = validateEvent({
    analyticsConsent: true,
    analyticsNoticeVersion: '2026-08-22',
    analyticsConsentAt: '2026-01-01T00:00:00Z',
    page: '/',
    visitorId: 'visitor-test',
  }).value;
  assert.deepEqual(service.enqueue(value), { ok: true });
  assert.equal(service.eventBufferLength, 1);
  assert.equal(delays[0], 2000);
  await assert.rejects(
    service.flushEventBuffer({ drain: true }),
    /unavailable/,
  );
  assert.equal(unhealthy, true);
  assert.equal(delays.at(-1), 5000);
  assert.equal(service.eventBufferLength, 1);
  assert.equal(stored.length, 0);
  fail = false;
  await service.flushEventBuffer({ drain: true });
  await service.flushEventBuffer({ drain: true });
  assert.equal(service.eventBufferLength, 0);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].eventType, 'page_view');
  assert.equal(stored[0].visitorId, 'visitor-test');
  assert.equal(typeof stored[0].id, 'string');
  assert.equal(Number.isFinite(Date.parse(stored[0].createdAt)), true);
});

test('analytics batches at 100 and rejects overflow after the pending batch plus 1000 buffered events', async () => {
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const batches = [];
  const service = createAnalyticsService({
    async insertBatch(batch) {
      await ready;
      batches.push(batch);
    },
  });
  for (let index = 0; index < 1100; index += 1)
    assert.equal(service.enqueue({ page: String(index) }).ok, true);
  assert.deepEqual(service.enqueue({ page: 'overflow' }), {
    ok: false,
    code: 'EVENT_QUEUE_FULL',
    message: '统计队列繁忙，请稍后再试。',
  });
  release();
  await service.flushEventBuffer({ drain: true });
  assert.equal(batches.length, 11);
  assert.equal(
    batches.every((batch) => batch.length === 100),
    true,
  );
  assert.equal(batches.flat().length, 1100);
  assert.equal(new Set(batches.flat().map((event) => event.id)).size, 1100);
});
