// tests/probes/now-imaging.spec.js — ON-DEMAND Playwright probes for the
// homepage "Currently imaging" card (spec:
// docs/superpowers/specs/2026-09-01-currently-imaging-design.md §6.2).
//
// What these pin, and why they need a browser: the card's four visible states
// are decided by a fetch, a Date comparison and a <dialog>. The unit tests
// (tests/now-imaging/logic.test.js) already pin the liveness window and the
// caption text as pure functions of (status, now); what they CANNOT see is
// whether now-imaging.js paints those decisions onto the page — whether a
// missing status really leaves the section hidden, whether the live class and
// the caption reach the DOM, whether the aspect box holds when the frame
// image loads, and whether Escape hands focus back to the trigger button.
// Those are the four probes below.
//
// No bucket required: the page fetches an ABSOLUTE
// https://live.dustin.space/now/status.json, so the probes intercept that URL
// with page.route() and answer from tests/probes/fixtures/. That is what makes
// both the live and the idle state testable on demand — waiting for the real
// rig to be idle is not a test strategy. The frame JPEG is intercepted the
// same way, so the probes never touch the network and the served image is
// byte-identical every run.
//
// These are NOT part of `npm test`: the `.spec.js` extension plus the
// tests/probes/ location keep them out of the `node:test` glob
// (`tests/**/*.test.js`). See tests/playwright-probes.md for how to run them.
//
// Run:    npx playwright test --config tests/probes/playwright.config.js --grep now-imaging
// In CI:  all four carry the "@ci" tag, so `--grep @ci` picks them up alongside
//         the nav-geometry subset. They earn that tag by being deterministic —
//         every input (status document, frame bytes, clock offset) is supplied
//         by the test rather than observed from the world.

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// Where the served site lives. Defaults to the Eleventy dev server (`npm start`,
// port 8080); override with BASE_URL to point at a preview deploy or a served
// _site/ build. 127.0.0.1 not localhost — must stay in lockstep with
// playwright.config.js, where the IPv4 literal avoids the CI runners'
// IPv6-first localhost resolution.
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8080';

// The two status documents this file serves, and the single JPEG they point at.
// The JPEG is a real 785×526 NINA bias frame (46 KB) — a real frame, not a
// generated placeholder, so the card is measured painting the kind of image it
// will actually paint. It sits under tests/now-imaging/fixtures/ with the
// agent-side fixtures (the NINA history and camera-info documents) because it
// came off the same rig, and so a future agent-side test can reuse it; this
// spec is its only reader today.
const FIXTURES = path.join(__dirname, 'fixtures');
const FRAME_JPEG = path.join(__dirname, '..', 'now-imaging', 'fixtures', 'frame.jpg');

// The absolute URLs now-imaging.js requests. Hard-coded here on purpose: if
// STATUS_URL in now-imaging.js ever changes, these probes must fail rather than
// silently follow it — a page that fetches a different origin than the one the
// CSP allows is exactly the regression worth catching.
const STATUS_URL = 'https://live.dustin.space/now/status.json';
const FRAME_URL_GLOB = 'https://live.dustin.space/now/**.jpg';

/**
 * statusFixture — read one committed fixture and re-date it relative to NOW.
 * Receives kind ('live' or 'idle'); returns the parsed status object.
 *
 * The committed JSON carries a fixed `updatedAt` only so the file is readable
 * on its own; every run overwrites it, because liveness is `now - updatedAt`
 * against isLive()'s max(20 min, 3 exposures) window — 3 × 300 s is 15 min, so
 * for these fixtures the 20-minute floor is what governs. A frozen timestamp
 * would make the live fixture read as live for twenty minutes after it was
 * written and idle forever after — the probe would pass on the day it was
 * committed and fail every day since, which is the classic time-bomb fixture.
 * 2 minutes ago is comfortably inside the live window; 6 hours ago is outside
 * it and lands on the "6 hours ago" branch of relativeAge (hours, not days).
 */
function statusFixture(kind) {
	const status = JSON.parse(fs.readFileSync(path.join(FIXTURES, `now-status-${kind}.json`), 'utf8'));
	const agoMs = kind === 'live' ? 2 * 60000 : 6 * 3600000;
	status.updatedAt = new Date(Date.now() - agoMs).toISOString();
	// Only the live document promises a next frame. Re-dating it into the near
	// future keeps the page's refetch timer on its long branch (~4 min), so no
	// second fetch lands mid-probe. The idle fixture has no such field at all,
	// which is what sends it down nextFetchDelayMs's 5-minute idle branch.
	if (kind === 'live') status.nextFrameExpectedAt = new Date(Date.now() + 4 * 60000).toISOString();
	return status;
}

/**
 * routeStatus — intercept both live.dustin.space requests for one page.
 * Receives the Playwright page and kind ('live' | 'idle' | 'none'); 'none'
 * answers 404, which is the "the rig has never published" case.
 * Must be called BEFORE page.goto: now-imaging.js fetches on load.
 */
async function routeStatus(page, kind) {
	await page.route(STATUS_URL, route => kind === 'none'
		? route.fulfill({ status: 404, body: 'not found' })
		: route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(statusFixture(kind)),
		}));
	await page.route(FRAME_URL_GLOB, route => route.fulfill({
		status: 200,
		contentType: 'image/jpeg',
		body: fs.readFileSync(FRAME_JPEG),
	}));
}

test.describe('now-imaging card', () => {

	test('@ci hidden when no status is published', async ({ page }) => {
		// Spec §6.2: there is never an "unavailable" card. A 404 (the state
		// before the first night, and the state whenever the agent is down)
		// must leave the section exactly as it shipped — hidden.
		await routeStatus(page, 'none');
		await page.goto(BASE_URL + '/');
		// A fixed wait, not a locator wait: the assertion is that nothing ever
		// happens, and there is no event to await for that. 1.5 s is far more
		// than the intercepted 404 needs to resolve and reject, and well under
		// the page's 8 s fetch timeout and 5-minute error retry, so a section
		// still hidden here stays hidden.
		await page.waitForTimeout(1500);
		await expect(page.locator('#now-imaging')).toBeHidden();
	});

	test('@ci live: renders name, designation, caption, pulsing state; no layout shift on image load', async ({ page }) => {
		await routeStatus(page, 'live');
		await page.goto(BASE_URL + '/');

		const section = page.locator('#now-imaging');
		await expect(section).toBeVisible();
		// is-live is what drives the pulsing dot in main.css; asserting the class
		// rather than an animation keeps the probe off Chromium's animation clock.
		await expect(section).toHaveClass(/is-live/);
		await expect(page.locator('#now-imaging-label')).toHaveText('Currently imaging');
		await expect(page.locator('#now-name')).toHaveText('Veil Nebula');
		await expect(page.locator('#now-designation')).toHaveText('NGC 6960');
		// The fixture's filter "Ha", 300 s and 23 subs, rendered by
		// now-imaging-logic.js caption(): the Hα glyph and the ordinal are the
		// two parts of that string a refactor could plausibly break.
		await expect(page.locator('#now-caption')).toHaveText('Hα · 300 s · 23rd sub tonight');

		// No layout shift: render() sets #now-frame's aspect-ratio from
		// status.frame.width/height BEFORE the image has bytes, so the box is
		// already the right height when the JPEG arrives. Measure the height
		// before and after the load and require it not to move.
		// scrollIntoViewIfNeeded first because the <img> is loading="lazy" —
		// off-screen it may never fetch, and the wait below would then burn the
		// whole test timeout instead of failing on the thing being measured.
		await page.locator('#now-frame').scrollIntoViewIfNeeded();
		const before = await page.locator('#now-frame').boundingBox();
		await page.locator('#now-image').evaluate(
			img => img.complete || new Promise(resolve => { img.onload = resolve; }),
			undefined,
			{ timeout: 10000 },   // bounded: a frame that never loads fails here, it does not hang
		);
		const after = await page.locator('#now-frame').boundingBox();
		expect(before && after, '#now-frame must have a box in both measurements').toBeTruthy();
		// 1px tolerance for sub-pixel rounding of the aspect-ratio box.
		expect(Math.abs(before.height - after.height), 'frame box height moved when the image loaded')
			.toBeLessThan(1);
	});

	test('@ci idle: "Last imaged · 6 hours ago", static dot', async ({ page }) => {
		// The same target and frame as the live fixture, but 6 hours old and
		// with no nextFrameExpectedAt: past the live window, so the card must
		// fall to the idle branch — is-idle (which in main.css swaps the dot to
		// a muted, un-animated one) and a relative-age label. The assertion is a
		// regex rather than an exact string because
		// Intl.RelativeTimeFormat owns the wording of the age and only the
		// "Last imaged · " prefix is ours.
		await routeStatus(page, 'idle');
		await page.goto(BASE_URL + '/');
		const section = page.locator('#now-imaging');
		await expect(section).toBeVisible();
		await expect(section).toHaveClass(/is-idle/);
		await expect(page.locator('#now-imaging-label')).toHaveText(/Last imaged · 6 hours ago/);
	});

	test('@ci dialog opens on click, closes on Escape, returns focus', async ({ page }) => {
		await routeStatus(page, 'live');
		await page.goto(BASE_URL + '/');

		await page.locator('#now-whats').click();
		await expect(page.locator('#now-dialog')).toBeVisible();
		await expect(page.locator('#now-dialog-title')).toHaveText('What you\'re looking at');

		// Deliberately NOT asserting which element holds focus while the dialog
		// is open. Task 9's review moved initial focus to .now-dialog-body (it
		// carries tabindex="-1" autofocus) so the arrow and Page keys scroll the
		// essay; pinning the close button here would re-assert the contract that
		// change replaced.
		await page.keyboard.press('Escape');
		await expect(page.locator('#now-dialog')).toBeHidden();
		// The return path IS ours: the dialog's close handler focuses the
		// trigger, so a keyboard user lands back where they left off rather than
		// at the top of the document.
		await expect(page.locator('#now-whats')).toBeFocused();
	});
});
