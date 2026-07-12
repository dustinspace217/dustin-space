// tests/probes/nav-geometry.spec.js — ON-DEMAND Playwright geometry probes.
//
// Issue #96, item 4. These probe the pixel geometry of the header nav and hero
// wordmark at the collapse boundary (1300px, per the #95 range-syntax fix).
// They are NOT part of `npm test` and NOT part of CI:
//   - the `.spec.js` extension + `tests/probes/` location keep them out of the
//     `node:test` glob (`tests/**/*.test.js`);
//   - Playwright is intentionally not a project dependency (see
//     tests/playwright-probes.md for how to run them on demand).
//
// This is a SKELETON: the vertical-centering and descent-clearance probes are
// implemented concretely; the zoom / root-font / nav-state probes are left as
// `test.fixme` with inline notes on what wiring they still need. Fill those in
// when a specific regression makes them worth the maintenance.
//
// Run: BASE_URL=http://localhost:8080 npx playwright test tests/probes/nav-geometry.spec.js

'use strict';

const { test, expect } = require('@playwright/test');

// Where the served site lives. Defaults to the Eleventy dev server (`npm start`,
// port 8080); override with BASE_URL to point at a preview deploy or a served
// _site/ build.
const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';

// The collapse boundary the CSS and JS agree on (main.css `@media (width < 1300px)`
// / NAV_COLLAPSE_MAX = 1299). The breakpoint-sync unit test guards the numbers;
// these probes verify the RENDERED consequence at and around them.
const COLLAPSE_BOUNDARY = 1300;

// Vertical center of a bounding box — the value all three header items must share
// so they read as one centered row (the production 2026-06-10 bug was a header
// item dropping out of the centered row).
function verticalCenter(box) {
	return box.y + box.height / 2;
}

test.describe('header geometry at the collapse boundary', () => {

	test('header vertical centering: logo and both clusters share one centered row', async ({ page }) => {
		// Just above the boundary the full nav is shown as two flanking clusters
		// plus the centered logo — all three must sit on the same centered row.
		await page.setViewportSize({ width: 1310, height: 680 });
		await page.goto(BASE_URL + '/');

		const logo  = await page.locator('.site-logo').boundingBox();
		const left  = await page.locator('.nav-cluster--left').boundingBox();
		const right = await page.locator('.nav-cluster--right').boundingBox();
		expect(logo && left && right, 'all three header items must be visible above the boundary').toBeTruthy();

		// Centers must agree within 1px (sub-pixel rounding tolerance).
		expect(Math.abs(verticalCenter(left)  - verticalCenter(logo))).toBeLessThanOrEqual(1);
		expect(Math.abs(verticalCenter(right) - verticalCenter(logo))).toBeLessThanOrEqual(1);
	});

	test('descent clearance at 1310×680: hero title never overlaps a nav cluster', async ({ page }) => {
		// The homepage hero title descends toward the header on scroll; at its
		// widest in-band moment it must not horizontally overlap either flank.
		// 1310×680 is the probe geometry from the issue (short viewport = least
		// shrink runway for the title).
		await page.setViewportSize({ width: 1310, height: 680 });
		await page.goto(BASE_URL + '/');

		const title = await page.locator('.hero-logo').boundingBox();
		const left  = await page.locator('.nav-cluster--left').boundingBox();
		const right = await page.locator('.nav-cluster--right').boundingBox();
		expect(title && left && right).toBeTruthy();

		// No horizontal overlap: the title's right edge stays left of the right
		// flank, and its left edge stays right of the left flank.
		expect(title.x + title.width, 'hero title overlaps the right nav cluster').toBeLessThanOrEqual(right.x);
		expect(left.x + left.width, 'left nav cluster overlaps the hero title').toBeLessThanOrEqual(title.x);
	});
});

test.describe('collapsed / expanded nav layout', () => {

	test('at 1250: nav is collapsed and opened links are full-width tap targets', async ({ page }) => {
		// Below the boundary the nav collapses to the hamburger; opening it must
		// stack the links full-width with ≥44px tap targets (a real bug this
		// round shrink-wrapped them).
		await page.setViewportSize({ width: 1250, height: 800 });
		await page.goto(BASE_URL + '/');

		await expect(page.locator('#nav-toggle-btn')).toBeVisible();
		await page.locator('#nav-toggle-btn').click();

		const links = page.locator('.site-nav a');
		const count = await links.count();
		expect(count).toBeGreaterThan(0);
		// Bounded loop over a known-small link list (the header nav).
		for (let i = 0; i < count; i++) {
			const box = await links.nth(i).boundingBox();
			expect(box, `nav link ${i} has no box when the menu is open`).toBeTruthy();
			expect(box.height, `nav link ${i} tap target is under 44px`).toBeGreaterThanOrEqual(44);
		}
	});

	test('at 1920: two nav clusters sit in the outer grid columns, logo centered', async ({ page }) => {
		await page.setViewportSize({ width: 1920, height: 1000 });
		await page.goto(BASE_URL + '/');

		const left  = await page.locator('.nav-cluster--left').boundingBox();
		const logo  = await page.locator('.site-logo').boundingBox();
		const right = await page.locator('.nav-cluster--right').boundingBox();
		expect(left && logo && right).toBeTruthy();

		// Left cluster is left of the logo, right cluster is right of it.
		expect(left.x + left.width).toBeLessThanOrEqual(logo.x);
		expect(logo.x + logo.width).toBeLessThanOrEqual(right.x);
	});

	test('keyboard: at 1250 with nav closed, Tab never focuses a zero-height nav element', async ({ page }) => {
		// When collapsed and closed the nav links are hidden; keyboard focus must
		// skip them rather than land on a zero-height, invisible target.
		await page.setViewportSize({ width: 1250, height: 800 });
		await page.goto(BASE_URL + '/');

		// Tab a bounded number of times and check focus never sits on a hidden
		// (zero-height) element inside the collapsed nav.
		for (let i = 0; i < 12; i++) {
			await page.keyboard.press('Tab');
			const focusedHeight = await page.evaluate(() => {
				const el = document.activeElement;
				if (!el) return null;
				const inNav = el.closest('.site-nav');
				return inNav ? el.getBoundingClientRect().height : -1; // -1 = not in nav, fine
			});
			if (focusedHeight !== -1 && focusedHeight !== null) {
				expect(focusedHeight, `Tab ${i} landed on a zero-height nav element`).toBeGreaterThan(0);
			}
		}
	});
});

test.describe('boundary edge cases (skeleton — need config/wiring)', () => {

	test.fixme('fractional viewport (~1299.2 via 125% zoom) collapses correctly', async ({ page }) => {
		// Needs a Playwright config with deviceScaleFactor / browser zoom so the
		// effective CSS width lands on a fractional value (e.g. 1299.2). The #95
		// range-syntax fix closed the fractional (1299,1300) fall-through; this
		// probe is the rendered proof. Wire up when regressions here recur.
		void page;
	});

	test.fixme('20px root font-size: breakpoints still gate on px width, not rem', async ({ page }) => {
		// Set the root font-size to 20px and confirm the collapse still happens at
		// the same viewport width (media queries are px-based, so this should be
		// invariant). Guards against a future rem-based media query slipping in.
		void page;
	});

	test.fixme('nav-state: resizing across the boundary does not stick the nav open/closed', async ({ page }) => {
		// Open the nav below the boundary, resize above it, and assert the nav
		// returns to the desktop layout (not stuck open) — and vice versa. Needs
		// the resize-and-reassert loop plus the specific stuck-state repro from
		// the nav-state issue referenced in #96.
		void page;
	});
});
