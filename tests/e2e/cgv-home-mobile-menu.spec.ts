import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'playwright/test';

const home = resolve('projects/cgv-home/screens/home/index.html');
const detail = resolve('projects/cgv-home/screens/movie-detail/index.html');
const seats = resolve('projects/cgv-home/screens/seat-selection/index.html');
test.skip(!existsSync(home), 'Màn hình CGV Home không có trong workspace này.');

test('mobile dùng nút Menu mở danh sách dọc thay vì cuộn ngang', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(pathToFileURL(home).href);

  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  const nav = page.locator('[data-design-id="home-el-11"]');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(nav).toBeHidden();

  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(nav).toBeVisible();
  const links = nav.locator('a');
  const first = await links.nth(0).boundingBox();
  const second = await links.nth(1).boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height);
  expect(Math.abs(second!.x - first!.x)).toBeLessThan(2);
  expect(await nav.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await page.keyboard.press('Escape');
  await expect(nav).toBeHidden();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await nav.getByRole('link', { name: 'PHIM' }).click();
  await expect(nav).toBeHidden();
});

test('desktop giữ menu ngang và không hiện nút Menu', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(pathToFileURL(home).href);
  const nav = page.locator('[data-design-id="home-el-11"]');
  await expect(nav).toBeVisible();
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeHidden();
  const first = await nav.locator('a').nth(0).boundingBox();
  const second = await nav.locator('a').nth(1).boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(second!.x).toBeGreaterThan(first!.x + first!.width);
});

test('trang chi tiết phim dùng cùng menu dọc trên mobile', async ({ page }) => {
  test.skip(!existsSync(detail), 'Màn hình Movie Detail không có trong workspace này.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(pathToFileURL(detail).href);
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  const nav = page.getByRole('navigation', { name: 'Điều hướng chính' });
  await expect(menu).toBeVisible();
  await expect(nav).toBeHidden();
  await menu.click();
  await expect(nav).toBeVisible();
  const first = await nav.locator('a').nth(0).boundingBox();
  const second = await nav.locator('a').nth(1).boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height);
  await page.keyboard.press('Escape');
  await expect(nav).toBeHidden();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(nav).toBeVisible();
  await expect(menu).toBeHidden();
});

test('header chọn ghế hiển thị bước đặt vé theo chiều dọc trên mobile', async ({ page }) => {
  test.skip(!existsSync(seats), 'Màn hình Seat Selection không có trong workspace này.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(pathToFileURL(seats).href);
  const stepper = page.locator('.checkout-head .stepper');
  await expect(stepper.locator('span')).toHaveCount(3);
  const first = await stepper.locator('span').nth(0).boundingBox();
  const second = await stepper.locator('span').nth(1).boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height);
  expect(await stepper.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.getByRole('link', { name: 'HỦY ĐẶT VÉ' })).toBeVisible();
});
