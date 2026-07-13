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
// All probes are implemented (issue #118 W7 finished the former `test.fixme`
// skeletons). Four are tagged "@ci" — the stable geometry probes wired into CI
// via `--grep @ci` (see tests/probes/playwright.config.js). The rest (keyboard
// focus, fractional-zoom, root-font, nav-state) are the slower/flakier human-run
// class, run on demand.
//
// Run all:  npx playwright test --config tests/probes/playwright.config.js
// CI subset: npx playwright test --config tests/probes/playwright.config.js --grep @ci

'use strict';

const { test, expect } = require('@playwright/test');

// Where the served site lives. Defaults to the Eleventy dev server (`npm start`,
// port 8080); override with BASE_URL to point at a preview deploy or a served
// _site/ build.
// 127.0.0.1 not localhost — must stay in lockstep with playwright.config.js,
// where the IPv4 literal avoids the CI runners' IPv6-first localhost
// resolution (readiness probe hitting ::1 while Eleventy binds IPv4).
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8080';

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

	test('@ci header vertical centering: logo and both clusters share one centered row', async ({ page }) => {
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

	test('@ci descent clearance at 1310×680: hero title never overlaps a nav cluster while scrolling', async ({ page }) => {
		// The homepage hero title DESCENDS toward the header as the page scrolls,
		// so overlap can appear at an intermediate scroll position, not only at
		// rest — the original probe measured a single at-rest frame and would miss
		// a mid-descent collision. This scrolls through a bounded ladder of
		// positions and asserts horizontal clearance at each. 1310×680 is the
		// issue's probe geometry (short viewport = least shrink runway).
		await page.setViewportSize({ width: 1310, height: 680 });
		await page.goto(BASE_URL + '/');

		// The header (and its flanking clusters) is sticky, so measure the flanks
		// once — they don't move as the body scrolls under them.
		const left  = await page.locator('.nav-cluster--left').boundingBox();
		const right = await page.locator('.nav-cluster--right').boundingBox();
		expect(left && right, 'both nav clusters must be visible above the boundary').toBeTruthy();

		// Bounded scroll ladder (Power-of-Ten rule 2: fixed count, fixed step).
		const STEPS = 12;
		const STEP_PX = 60;
		for (let i = 0; i <= STEPS; i++) {
			const y = i * STEP_PX;
			await page.evaluate(scrollY => window.scrollTo(0, scrollY), y);
			// Let the scroll-driven title animation settle before measuring.
			await page.waitForTimeout(50);

			const title = await page.locator('.hero-logo').boundingBox();
			// Once the title snaps into the header it leaves the .hero-logo layout;
			// with nothing left to overlap, the descent phase is over.
			if (!title) break;

			// No horizontal overlap (1px subpixel-rounding tolerance): the title's
			// right edge stays left of the right flank, its left edge right of the
			// left flank.
			expect(title.x + title.width, `hero title overlaps the right nav cluster at scrollY=${y}`)
				.toBeLessThanOrEqual(right.x + 1);
			expect(left.x + left.width, `left nav cluster overlaps the hero title at scrollY=${y}`)
				.toBeLessThanOrEqual(title.x + 1);
		}
	});
});

test.describe('collapsed / expanded nav layout', () => {

	test('@ci at 1250: nav is collapsed and opened links are full-width tap targets', async ({ page }) => {
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

	test('@ci at 1920: two nav clusters sit in the outer grid columns, logo centered', async ({ page }) => {
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

test.describe('boundary edge cases', () => {

	test('fractional viewport (~1299.2 via 125% zoom) collapses to the hamburger', async ({ page }) => {
		// The #95 range-syntax fix closed the fractional (1299,1300) fall-through;
		// this is the rendered proof at a fractional effective width. Chromium
		// applies document-level CSS `zoom` to the initial containing block, so a
		// media query sees viewportWidth / zoom: 1624 / 1.25 = 1299.2 — inside the
		// gap. The nav must be COLLAPSED there (hamburger visible).
		//
		// Note: this relies on Chromium's zoom→media-width behavior. It's kept out
		// of the CI @ci subset (no "@ci" prefix) precisely because that mechanism
		// is browser-version-sensitive; run it on demand when chasing a boundary
		// regression.
		await page.setViewportSize({ width: 1624, height: 800 });
		await page.goto(BASE_URL + '/');
		await page.evaluate(() => { document.documentElement.style.zoom = '1.25'; });
		await page.waitForTimeout(50);

		await expect(page.locator('#nav-toggle-btn')).toBeVisible();
	});

	test('20px root font-size: breakpoints still gate on px width, not rem', async ({ page }) => {
		// Media queries are px-based, so enlarging the root font must NOT move the
		// collapse boundary. At 1310px (just above 1300) the nav stays expanded
		// even with a 20px root; if a rem-based media query slipped in, the 20px
		// root would shift the effective breakpoint and wrongly collapse the nav.
		await page.setViewportSize({ width: 1310, height: 800 });
		await page.goto(BASE_URL + '/');
		await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; });
		await page.waitForTimeout(50);

		// Above the boundary: hamburger hidden, both clusters shown.
		await expect(page.locator('#nav-toggle-btn')).toBeHidden();
		await expect(page.locator('.nav-cluster--left')).toBeVisible();
	});

	test('nav-state: resizing across the boundary does not stick the nav open/closed', async ({ page }) => {
		// Open the nav below the boundary, cross above it, and assert the desktop
		// layout returns (hamburger gone, clusters shown) rather than staying stuck
		// open — then cross back below and confirm the hamburger returns.
		await page.setViewportSize({ width: 1250, height: 800 });
		await page.goto(BASE_URL + '/');
		await expect(page.locator('#nav-toggle-btn')).toBeVisible();
		await page.locator('#nav-toggle-btn').click(); // open the menu below the boundary

		// Cross ABOVE the boundary — the collapsed menu must give way to the desktop nav.
		await page.setViewportSize({ width: 1400, height: 800 });
		await page.waitForTimeout(100);
		await expect(page.locator('#nav-toggle-btn')).toBeHidden();
		await expect(page.locator('.nav-cluster--left')).toBeVisible();

		// Cross BACK below — the hamburger returns and nothing is stuck.
		await page.setViewportSize({ width: 1250, height: 800 });
		await page.waitForTimeout(100);
		await expect(page.locator('#nav-toggle-btn')).toBeVisible();
	});
});
