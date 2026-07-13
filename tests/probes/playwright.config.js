// tests/probes/playwright.config.js — config for the on-demand nav-geometry
// probes (issue #96 item 4, extended in #118 W7).
//
// Kept HERE (under tests/probes/) rather than at the repo root on purpose: the
// root `npm test` (node:test) and this Playwright runner are deliberately
// separate tools, and a root playwright.config.js would invite `npx playwright
// test` to auto-run against the whole tree. Invoke this config explicitly:
//
//   npx playwright test --config tests/probes/playwright.config.js
//   npx playwright test --config tests/probes/playwright.config.js --grep @ci
//
// The `--grep @ci` form runs only the four stable geometry probes wired into CI
// (their titles start with "@ci"); the remaining probes (keyboard focus, zoom,
// root-font, nav-state) are the slower/flakier human-run class and are left out
// of the grep.
//
// webServer: Playwright boots the Eleventy dev server itself so CI needs no
// separate serve step. Locally, an already-running `npm start` is reused.

'use strict';

const { defineConfig } = require('@playwright/test');

// Effective base URL for the probes. Matches the BASE_URL default the spec
// reads, so the spec's `page.goto(BASE_URL + '/')` and this config agree.
const PORT = process.env.PORT || 8080;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

module.exports = defineConfig({
	testDir: __dirname,
	testMatch: '**/*.spec.js',
	// Geometry probes are timing-sensitive; give each a little headroom but fail
	// rather than hang. A single retry absorbs a one-off animation-timing miss in
	// CI without masking a real regression (two failures in a row still fails).
	timeout: 30000,
	retries: process.env.CI ? 1 : 0,
	// Geometry is viewport-order-sensitive within a test; keep workers modest.
	workers: process.env.CI ? 1 : undefined,
	use: {
		baseURL: BASE_URL,
	},
	projects: [
		{
			name: 'chromium',
			use: { browserName: 'chromium' },
		},
	],
	// Boot the site under test. In CI (no server running) Playwright starts it;
	// locally it reuses a running `npm start`.
	webServer: {
		command: `npx @11ty/eleventy --serve --port ${PORT}`,
		url: BASE_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 120000,
	},
});
