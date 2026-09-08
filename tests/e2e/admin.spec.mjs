import { test, expect } from './fixtures.mjs';

test('admin updates survive restart, deletion persists and logout revokes APIs', async ({
  page,
  app,
  browserHealth,
}) => {
  const id = '00000000-0000-4000-8000-000000000008';
  app.seedInquiry(id);
  browserHealth.expectHttpError('GET', '/api/session', 401);
  await page.goto('/admin');
  await expect(page.locator('#login-view')).toBeVisible();
  await page.getByLabel('管理员密码').fill(app.password);
  await page.getByRole('button', { name: '登录', exact: false }).click();
  await expect(page.locator('#dashboard-view')).toBeVisible();
  const row = page
    .locator('#inquiry-rows tr')
    .filter({ hasText: 'Synthetic Parent' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('000****0000');
  await expect(row).not.toContainText('00000000000');
  await expect(row.locator('a[href^="tel:"]')).toHaveCount(0);
  await row.getByRole('button', { name: '显示电话' }).click();
  await expect(row).toContainText('00000000000');
  await expect(row.locator('a[href="tel:00000000000"]')).toHaveCount(1);
  const status = row.locator('.status-select');
  await expect(status).toHaveValue('New');
  const updated = page.waitForResponse(
    (response) => response.request().method() === 'PATCH',
  );
  await status.selectOption('Contacted');
  expect((await updated).status()).toBe(200);
  await expect(status).toHaveValue('Contacted');
  expect(app.inquiries()[0].status).toBe('Contacted');
  await page.waitForLoadState('networkidle');
  await app.restart();
  await page.reload();
  await expect(page.locator('#dashboard-view')).toBeVisible();
  await expect(status).toHaveValue('Contacted');
  await page.getByRole('button', { name: '刷新数据' }).click();
  await expect(status).toHaveValue('Contacted');

  page.once('dialog', (dialog) => dialog.accept());
  const deleted = page.waitForResponse(
    (response) => response.request().method() === 'DELETE',
  );
  await row.getByRole('button', { name: '删除', exact: true }).click();
  expect((await deleted).status()).toBe(200);
  await expect(row).toHaveCount(0);
  expect(app.inquiries()).toHaveLength(0);
  await page.reload();
  await expect(page.locator('#inquiry-rows')).toContainText('暂无预约记录');
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.locator('#login-view')).toBeVisible();
  await expect(page.locator('#dashboard-view')).toBeHidden();
  for (const endpoint of ['/api/session', '/api/dashboard', '/api/inquiries']) {
    const response = await page.request.get(endpoint);
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBeTruthy();
    expect(body.error.requestId).toBeTruthy();
  }
  browserHealth.expectHttpError('GET', '/api/session', 401);
  await page.reload();
  await expect(page.locator('#login-view')).toBeVisible();
  await expect(page.locator('#dashboard-view')).toBeHidden();
});
