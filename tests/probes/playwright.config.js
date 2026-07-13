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
//
// 127.0.0.1 rather than localhost: on GitHub's ubuntu runners (Node >= 17),
// `localhost` resolves IPv6-first to ::1, but Eleventy's dev server binds
// the IPv4 loopback — so Playwright's webServer readiness probe connects to
// ::1, gets refused, and times out after 120s even though the server is up.
// That exact failure broke PR #133's first CI run. IPv4-literal sidesteps
// the resolver entirely.
const PORT = process.env.PORT || 8080;
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;

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
		// cwd is load-bearing: Playwright spawns webServer.command from the CONFIG
		// FILE's directory by default (tests/probes/), where Eleventy finds no
		// .eleventy.js or src/ — it "succeeds" with `Wrote 0 files`, prints its
		// server banner, and serves 404 for /, which the readiness poll below
		// never accepts. That empty-site 404 loop is what timed out PR #133's CI
		// twice (verified by reproducing the 404 locally from this directory).
		// Locally the bug hid behind reuseExistingServer. Repo root fixes it.
		cwd: require('path').resolve(__dirname, '../..'),
		url: BASE_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 120000,
	},
});
