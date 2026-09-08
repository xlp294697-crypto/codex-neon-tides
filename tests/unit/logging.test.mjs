import test from 'node:test';
import assert from 'node:assert/strict';
import { writeLog } from '../../src/logging.mjs';
import { assertSupportedNodeVersion } from '../../tools/require-node-24.mjs';

test('structured logger emits only allowlisted fields and never raw failures', (t) => {
  const output = [];
  t.mock.method(console, 'error', (line) => output.push(String(line)));
  writeLog('error', 'ANALYTICS_FLUSH_FAILED', {
    requestId: 'safe-request-id',
    error: new Error('SENSITIVE_LOG_SENTINEL C:/private/site.db'),
    message: 'SENSITIVE_LOG_SENTINEL',
    stack: '/private/source.mjs:42',
    arbitrary: 'secret',
  });
  assert.equal(output.length, 1);
  const entry = JSON.parse(output[0]);
  assert.equal(entry.category, 'ANALYTICS_FLUSH_FAILED');
  assert.equal(entry.requestId, 'safe-request-id');
  assert.deepEqual(Object.keys(entry).sort(), [
    'category',
    'level',
    'requestId',
    'timestamp',
  ]);
  assert.doesNotMatch(
    output[0],
    /SENSITIVE_LOG_SENTINEL|private|site\.db|stack/i,
  );
});

test('Node launcher rejects unsupported major versions before startup', () => {
  assert.throws(
    () => assertSupportedNodeVersion('23.9.0'),
    /requires Node\.js 24/,
  );
  assert.doesNotThrow(() => assertSupportedNodeVersion('24.0.0'));
});
