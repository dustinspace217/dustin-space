/**
 * Visitor regressions from the September project review. Uses the built page
 * and real DOM/CSS; only the external atlas is stubbed to inspect its geometry
 * without starting WebGL or contacting survey services in the default CI run.
 */
'use strict';

const { test, expect } = require('@playwright/test');

for (const width of [390, 1440]) {
	for (const reducedMotion of ['reduce', 'no-preference']) {
		test(`@ci Home link has visible keyboard focus at ${width}px (${reducedMotion})`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await page.emulateMedia({ reducedMotion });
			await page.route('https://live.dustin.space/**', route => route.fulfill({ status: 404, body: '' }));
			await page.goto('/');
			if (reducedMotion === 'no-preference') {
				await page.evaluate(() => window.scrollTo(0, 1200));
				await expect(page.locator('.site-logo')).toHaveJSProperty('tabIndex', 0);
			}
			// The first stop is Skip to content; the next is the Home link.
			await page.keyboard.press('Tab');
			await page.keyboard.press('Tab');
			const home = page.locator('.site-logo');
			await expect(home).toBeFocused();
			await expect(home).toHaveCSS('opacity', '1');
			await expect(home).toHaveCSS('outline-style', 'solid');
			if (reducedMotion === 'no-preference') {
				await expect(page.locator('.hero-logo')).toHaveCSS('visibility', 'hidden');
				// Resizing must not restore an inline opacity that overrides focus.
				await page.setViewportSize(width === 390
					? { width: 844, height: 390 } : { width: 1439, height: 900 });
				await expect(home).toBeFocused();
				await expect(home).toHaveCSS('opacity', '1');
				await page.keyboard.press('Tab');
				await expect(page.locator('.hero-logo')).toHaveCSS('visibility', 'visible');
			}
		});
	}
}

test('@ci Home remains keyboard-accessible when an open mobile menu rotates', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	await page.locator('#nav-toggle-btn').click();
	await page.setViewportSize({ width: 844, height: 390 });
	const home = page.locator('.site-logo');
	await expect(home).toHaveJSProperty('tabIndex', 0);
	await expect(home).toHaveCSS('pointer-events', 'auto');
	await page.keyboard.press('Tab');
	await home.focus();
	await expect(home).toHaveCSS('opacity', '1');
});

test('@ci Atlas footprint follows the rotated plate solution', async ({ page }) => {
	// This adapter records the inputs the real page gives Aladin. Projection
	// still runs through the production WCS module and current gallery data.
	await page.route('**/assets/js/aladin-3.8.2.js', route => route.fulfill({
		contentType: 'text/javascript',
		body: `export default {
			init: Promise.resolve(),
			aladin(selector, options) { window.atlasOptions = options; return { addOverlay() {} }; },
			graphicOverlay() { return { add(corners) { window.atlasCorners = corners; } }; },
			polygon(corners) { return corners; }
		};`,
	}));
	await page.goto('/gallery/pleiades-cluster/');
	await page.locator('.aladin-lite-container').first().scrollIntoViewIfNeeded();
	await page.waitForFunction(() => Array.isArray(window.atlasCorners));
	const fractions = await page.evaluate(() => {
		const data = JSON.parse(document.getElementById('image-data').textContent);
		return window.atlasCorners.map(([ra, dec]) => window.DSWcs.skyToPixelFrac(ra, dec, data.variants[0].wcs));
	});
	const edges = [[0, 0], [1, 0], [1, 1], [0, 1]];
	for (let index = 0; index < edges.length; index++) {
		expect(fractions[index].x).toBeCloseTo(edges[index][0], 8);
		expect(fractions[index].y).toBeCloseTo(edges[index][1], 8);
	}
	const view = await page.evaluate(() => {
		const [ra, dec] = window.atlasOptions.target.split(' ').map(Number);
		const box = document.querySelector('.aladin-lite-container').getBoundingClientRect();
		return {
			width: window.atlasOptions.fov,
			height: window.atlasOptions.fov * box.height / box.width,
			offsets: window.atlasCorners.map(corner => [
				Math.abs(corner[0] - ra) * Math.cos(dec * Math.PI / 180), Math.abs(corner[1] - dec),
			]),
		};
	});
	for (const [x, y] of view.offsets) {
		expect(x).toBeLessThan(view.width / 2);
		expect(y).toBeLessThan(view.height / 2);
	}
});
