import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { loadConfig } from '../../src/config.mjs';

const valid = {
  NODE_ENV: 'test',
  ADMIN_PASSWORD: 'Valid-Testing-Key-4937!',
  SESSION_SECRET: 's'.repeat(48),
};

test('DATA_PATH addresses SQLite and defaults to data/site.db', () => {
  assert.equal(loadConfig(valid, process.cwd()).dataPath, path.join(process.cwd(), 'data', 'site.db'));
  assert.equal(loadConfig({ ...valid, DATA_PATH: './custom.db' }, process.cwd()).dataPath, path.resolve('custom.db'));
});

test('loadConfig rejects missing administrator credentials', () => {
  assert.throws(
    () =>
      loadConfig(
        { NODE_ENV: 'test', SESSION_SECRET: valid.SESSION_SECRET },
        process.cwd(),
      ),
    /ADMIN_PASSWORD/,
  );
});

test('loadConfig rejects a missing session secret', () => {
  assert.throws(
    () =>
      loadConfig(
        { NODE_ENV: 'test', ADMIN_PASSWORD: valid.ADMIN_PASSWORD },
        process.cwd(),
      ),
    /SESSION_SECRET/,
  );
});

test('loadConfig rejects data stored under public', () => {
  assert.throws(
    () =>
      loadConfig({ ...valid, DATA_PATH: './public/site.db' }, process.cwd()),
    /public/,
  );
});

test('loadConfig accepts a supported IANA report time zone', () => {
  const config = loadConfig(
    { ...valid, REPORT_TIME_ZONE: 'America/New_York' },
    process.cwd(),
  );

  assert.equal(config.reportTimeZone, 'America/New_York');
});

test('loadConfig applies bounded numeric defaults in a frozen configuration', () => {
  const config = loadConfig(valid, process.cwd());

  assert.equal(config.port, 3002);
  assert.equal(config.maxBodyBytes, 65536);
  assert.equal(config.eventRetentionDays, 180);
  assert.equal(config.maxEventRecords, 25000);
  assert.equal(config.maxInquiryRecords, 10000);
  assert.equal(config.sessionHours, 8);
  assert.equal(config.reportTimeZone, 'Asia/Shanghai');
  assert.equal(Object.isFrozen(config), true);
});
