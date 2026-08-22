import { test, expect } from '@playwright/test';

test.describe('Responsive & Accessibility Layout Checks', () => {
  test('adapts to viewport dimensions and verifies accessibility baseline', async ({
    page,
  }) => {
    const viewport = page.viewportSize();
    expect(viewport).toBeDefined();
    expect(viewport?.width).toBeGreaterThan(0);
    expect(viewport?.height).toBeGreaterThan(0);

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const htmlLang = await page.getAttribute('html', 'lang');
    expect(htmlLang).toBeTruthy();

    const mainLandmark = page.locator('main');
    await expect(mainLandmark).toBeVisible();

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1); 
  });
});
