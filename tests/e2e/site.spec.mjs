import { test, expect, fillInquiry } from './fixtures.mjs';

test('navigation, published images, accessible media controls and privacy page work', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '仅必要功能' }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('public-home.png') });

  const navigation = page.locator('.site-header nav');
  if (isMobile) {
    await expect(navigation).toBeHidden();
    await page.locator('.header-cta').click();
    await expect(page).toHaveURL(/#assessment$/);
    await expect(page.locator('#booking-form')).toBeInViewport();
    await page.locator('.site-footer a[href="#qualifications"]').click();
  } else {
    await expect(navigation).toBeVisible();
    for (const section of [
      'courses',
      'qualifications',
      'team',
      'outcomes',
      'assessment',
    ]) {
      await navigation.locator(`a[href="#${section}"]`).click();
      await expect(page).toHaveURL(new RegExp(`#${section}$`));
      await expect(page.locator(`#${section}`)).toBeInViewport();
    }
  }

  const images = page.locator('[data-gallery-item] img');
  expect(await images.count()).toBeGreaterThan(0);
  for (const image of await images.all()) {
    await image.scrollIntoViewIfNeeded();
    await expect(image).toHaveJSProperty('complete', true);
    expect(await image.evaluate((element) => element.naturalWidth > 0)).toBe(
      true,
    );
    await expect(image).toHaveAttribute('alt', /\S/);
  }
  const firstCard = page.locator('[data-gallery-item]').first();
  await firstCard.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: '关闭', exact: true }),
  ).toBeFocused();
  await expect(page.locator('#dialog-count')).toHaveText('1 / 22');
  await dialog.getByRole('button', { name: '下一张' }).click();
  await expect(page.locator('#dialog-count')).toHaveText('2 / 22');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#dialog-count')).toHaveText('1 / 22');
  await expect(page.locator('#dialog-image')).toHaveJSProperty(
    'complete',
    true,
  );
  expect(
    await page
      .locator('#dialog-image')
      .evaluate((element) => element.naturalWidth > 0),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('media-dialog.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(firstCard).toBeFocused();
  await firstCard.click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.locator('.site-footer a[href="/privacy"]').click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '预约信息处理告知',
  );
  await expect(
    page.getByRole('heading', { name: /未成年人信息/ }),
  ).toBeVisible();
  await page.getByRole('link', { name: '返回预约' }).click();
  await expect(page.locator('#analytics-consent')).toBeHidden();
});

test('refusal persists without analytics or visitor identity and still permits inquiry', async ({
  page,
  app,
}) => {
  const eventRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/events')
      eventRequests.push(request.method());
  });
  await page.goto('/?utm_source=synthetic-campaign');
  await expect(page.locator('#analytics-consent')).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem('jiuyueVisitor')),
  ).toBeNull();
  await page.getByRole('button', { name: '仅必要功能' }).click();
  await page.reload();
  await expect(page.locator('#analytics-consent')).toBeHidden();
  await fillInquiry(page);
  const submitted = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/inquiries') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '提交预约' }).click();
  expect((await submitted).status()).toBe(201);
  await expect(page.getByRole('status')).toContainText('预约已提交');
  await expect(page.getByLabel('家长姓名')).toBeEmpty();
  const records = app.inquiries();
  expect(records).toHaveLength(1);
  expect(records[0].analyticsAttributed).toBe(false);
  expect(records[0].source).toBe('');
  expect(records[0].sourcePage).toBe('');
  expect(records[0].privacyNoticeVersion).toBe('2026-08-22');
  expect(await app.events()).toEqual([]);
  expect(eventRequests).toEqual([]);
  expect(
    await page.evaluate(() => localStorage.getItem('jiuyueVisitor')),
  ).toBeNull();
});

test('acceptance sends real analytics and withdrawal stops subsequent tracking', async ({
  page,
  app,
}) => {
  await page.goto('/?utm_source=synthetic-campaign');
  const pageView = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/events') &&
      response.request().postDataJSON()?.eventType === 'page_view',
  );
  await page.getByRole('button', { name: '同意统计' }).click();
  expect((await pageView).status()).toBe(202);
  expect(
    await page.evaluate(() => localStorage.getItem('jiuyueVisitor')),
  ).toBeTruthy();
  await fillInquiry(page);
  const conversion = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/events') &&
      response.request().postDataJSON()?.eventType === 'booking_success',
  );
  await page.getByRole('button', { name: '提交预约' }).click();
  await expect(page.getByRole('status')).toContainText('预约已提交');
  expect((await conversion).status()).toBe(202);
  const records = app.inquiries();
  expect(records).toHaveLength(1);
  expect(records[0].analyticsAttributed).toBe(true);
  expect(records[0].source).toBe('synthetic-campaign');
  const events = await app.events();
  expect(events.some((event) => event.eventType === 'page_view')).toBe(true);
  expect(events.some((event) => event.eventType === 'booking_success')).toBe(
    true,
  );
  await page.getByRole('button', { name: '访问统计设置' }).click();
  await page.getByRole('button', { name: '仅必要功能' }).click();
  await page.waitForLoadState('networkidle');
  const afterWithdrawal = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/events')
      afterWithdrawal.push(request.method());
  });
  await page.reload();
  await page.locator('[data-gallery-item]').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(
    await page.evaluate(() => localStorage.getItem('jiuyueVisitor')),
  ).toBeNull();
  expect(afterWithdrawal).toEqual([]);
});

test('invalid phone shows server validation and keeps entered fields for correction', async ({
  page,
  app,
  browserHealth,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '仅必要功能' }).click();
  await fillInquiry(page, 'invalid-phone');
  browserHealth.expectHttpError('POST', '/api/inquiries', 422);
  await page.getByRole('button', { name: '提交预约' }).click();
  await expect(page.getByRole('status')).toContainText('有效电话');
  await expect(page.getByLabel('家长姓名')).toHaveValue('Synthetic Parent');
  await expect(page.getByRole('button', { name: '提交预约' })).toBeEnabled();
  expect(app.inquiries()).toHaveLength(0);
  await page.getByLabel('联系电话', { exact: false }).fill('00000000000');
  await page.getByRole('button', { name: '提交预约' }).click();
  await expect(page.getByRole('status')).toContainText('预约已提交');
  expect(app.inquiries()).toHaveLength(1);
});
