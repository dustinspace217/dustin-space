/**
 * Exercise the vendored computation with the portfolio's real CSP. Eleventy's
 * local server does not apply Pages _headers, so the navigation response gets
 * that policy explicitly. A plain-server test missed the blocked module worker.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

test('@ci Descent computes and discloses its approximation under the portfolio CSP', async ({ page }) => {
	test.setTimeout(45000);
	const headers = fs.readFileSync(path.resolve(__dirname, '../../src/_headers'), 'utf8');
	const csp = headers.match(/^\s+Content-Security-Policy: (.+)$/m)[1];
	await page.route('**/descent/', async route => {
		const response = await route.fetch();
		await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } });
	});
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const errors = [];
	let startedWorkers = 0;
	page.on('pageerror', error => errors.push(error.message));
	page.on('worker', () => { startedWorkers++; });
	const response = await page.goto('/descent/');
	expect(response.headers()['content-security-policy']).toBe(csp);
	await expect(page.locator('#stage')).toBeVisible({ timeout: 40000 });
	await page.locator('[data-step="5"]').click();
	await expect(page.locator('#mi-value')).toHaveText('0.43');
	await expect(page.locator('#rung-failed-nulls')).toContainText('2 of the 135 recording blocks');
	await expect(page.locator('#summary-failed-nulls')).toContainText('241 of the 1663 pairs');
	await expect(page.locator('#load-failure')).toBeHidden();
	expect(startedWorkers).toBe(1);
	await expect.poll(() => page.workers().length).toBe(0);
	expect(errors).toEqual([]);
});
