import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicRoot = path.join(root, 'public');
const mediaRoot = path.join(publicRoot, 'media');

function containsExif(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return false;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (
      marker === 0x00 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) break;
    if (
      marker === 0xe1 &&
      buffer.subarray(offset + 4, offset + 10).toString('ascii') === 'Exif\0\0'
    )
      return true;
    offset += 2 + length;
  }
  return false;
}

test('发布媒体清单与页面引用严格一致', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(root, 'media-manifest.json'), 'utf8'),
  );
  assert.equal(manifest.length, 22);
  assert.equal(
    new Set(manifest.map((item) => item.id)).size,
    manifest.length,
    '媒体 ID 必须唯一',
  );
  assert.equal(
    new Set(manifest.map((item) => item.file)).size,
    manifest.length,
    '媒体文件名必须唯一',
  );

  const actualFiles = (await readdir(mediaRoot)).sort();
  const expectedFiles = manifest.map((item) => item.file).sort();
  assert.deepEqual(
    actualFiles,
    expectedFiles,
    '媒体目录只能包含清单中的发布版图片',
  );

  const index = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  for (const item of manifest) {
    assert.match(item.file, /^[a-z0-9][a-z0-9-]*\.jpg$/);
    assert.ok(item.alt && item.title, `${item.file} 缺少替代文字或标题`);
    assert.ok(
      index.includes(`/assets/media/${item.file}`),
      `${item.file} 未被首页引用`,
    );
    assert.ok(
      index.includes(`data-target-id="${item.id}"`),
      `${item.id} 缺少稳定统计标识`,
    );
    const filePath = path.join(mediaRoot, item.file);
    const information = await lstat(filePath);
    assert.ok(
      information.isFile() && !information.isSymbolicLink(),
      `${item.file} 必须是普通文件`,
    );
    const image = await readFile(filePath);
    assert.equal(image[0], 0xff);
    assert.equal(image[1], 0xd8);
    assert.equal(
      containsExif(image),
      false,
      `${item.file} 不应包含 EXIF 元数据`,
    );
  }
});

test('首页包含预约、独立同意与正确联系方式', async () => {
  const index = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  assert.ok(index.includes('18061736378') || index.includes('180 6173 6378'));
  assert.ok(index.includes('name="privacyConsent"'));
  assert.ok(index.includes('name="website"'));
  assert.ok(index.includes('id="analytics-consent"'));
  assert.ok(index.includes('id="analytics-settings"'));
  assert.ok(index.includes('统计数据中不写入您的IP地址'));
  assert.ok(index.includes('去标识化访问统计'));
  assert.equal(index.includes('href="/admin"'), false, '官网不应公开后台入口');

  const app = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  assert.ok(
    app.includes("const consentVersionKey = 'jiuyueAnalyticsConsentVersion'"),
  );
  assert.ok(app.includes('function hasAnalyticsConsent()'));
  assert.ok(app.includes('getConsentVersion() === analyticsNoticeVersion'));
  assert.ok(app.includes("privacyConsent: fields.privacyConsent === 'yes'"));
  assert.ok(app.includes('const analyticsAllowed = hasAnalyticsConsent()'));
  assert.ok(
    app.includes("sourcePage: analyticsAllowed ? location.pathname : ''"),
  );
  assert.ok(app.includes('utm: analyticsAllowed ? campaignContext() : {}'));
  const bookingHandler = app.slice(
    app.indexOf("document.querySelector('#booking-form')"),
  );
  assert.equal(
    bookingHandler.includes('visitorId:'),
    false,
    '具名预约请求不得携带随机访客标识',
  );
});

test('隐私页与空数据种子存在', async () => {
  const privacy = await readFile(path.join(publicRoot, 'privacy.html'), 'utf8');
  for (const text of [
    '宜兴市氿悦体育发展有限公司',
    '18061736378',
    '未成年人信息',
    '去标识化访问统计',
    '180 天',
    '随机访客标识也不会写入具名预约记录',
    '删除',
  ]) {
    assert.ok(privacy.includes(text), `隐私页缺少：${text}`);
  }
  const gitignore = await readFile(path.join(root, '.gitignore'), 'utf8');
  assert.ok(
    gitignore.includes('data/*.json'),
    'Git 忽略规则必须覆盖生产询盘数据',
  );
  const data = JSON.parse(
    await readFile(path.join(root, 'data', 'site-data.json'), 'utf8'),
  );
  assert.deepEqual(data.events, []);
  assert.deepEqual(data.inquiries, []);
});
