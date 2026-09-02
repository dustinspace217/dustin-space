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
// the caption reach the DOM, whether the card reserves the PUBLISHED frame box
// before the image has any bytes, and whether Escape hands focus back to the
// trigger button. Those are the four probes below.
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

// The aspect ratio the live fixture publishes (frame.width / frame.height), and
// how far the measured box may sit from it.
//
// The tolerance is 0.25% rather than a comfortable 1% for one specific reason:
// main.css's `.now-frame` already declares `aspect-ratio: 3 / 2` as a fallback,
// and 3/2 is only 0.51% away from 785/526. A 1% tolerance would accept the CSS
// fallback, so the probe would still pass with render()'s inline aspectRatio
// assignment deleted — i.e. it could not fail for the reason it exists.
// The bound sits between two MEASURED numbers rather than a guessed margin:
// a correctly reserved box came in at 0.0000173 off the published ratio, and
// the CSS fallback (aspectRatio assignment deleted) at 0.0050955. 0.0025 is
// ~144× the observed rounding noise and ~half the failure it has to catch.
const FRAME_RATIO = 785 / 526;
const FRAME_RATIO_TOLERANCE = 0.0025;

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
 * deferred — a promise plus the function that resolves it.
 * Returns { promise, release }. Used to park a route handler: the handler
 * awaits `promise`, and the test calls `release()` when it wants the response
 * to go out. Nothing here waits forever — an unreleased gate fails on the
 * config's 30 s per-test timeout rather than hanging the run.
 */
function deferred() {
	let release;
	const promise = new Promise(resolve => { release = resolve; });
	return { promise, release };
}

/**
 * routeStatus — intercept both live.dustin.space requests for one page.
 * Receives the Playwright page, kind ('live' | 'idle' | 'none'), and an
 * optional `holdFrameUntil` promise. 'none' answers 404, which is the "the rig
 * has never published" case.
 * Must be called BEFORE page.goto: now-imaging.js fetches on load.
 *
 * holdFrameUntil parks the JPEG response until the caller resolves it. That
 * hold is what makes the layout-shift probe able to fail: the fixture is 46 KB
 * fulfilled from memory, so it can finish decoding before the first
 * measurement runs, leaving the before/after comparison to read the same
 * post-load state twice and pass no matter what the page did.
 */
async function routeStatus(page, kind, holdFrameUntil) {
	await page.route(STATUS_URL, route => kind === 'none'
		? route.fulfill({ status: 404, body: 'not found' })
		: route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(statusFixture(kind)),
		}));
	await page.route(FRAME_URL_GLOB, async route => {
		if (holdFrameUntil) await holdFrameUntil;
		await route.fulfill({
			status: 200,
			contentType: 'image/jpeg',
			body: fs.readFileSync(FRAME_JPEG),
		});
	});
}

test.describe('now-imaging card', () => {

	test('@ci hidden when no status is published', async ({ page }) => {
		// Spec §6.2: there is never an "unavailable" card. A 404 (the state
		// before the first night, and the state whenever the agent is down)
		// must leave the section exactly as it shipped — hidden.
		await routeStatus(page, 'none');
		// Positive control, registered before the navigation that triggers it.
		// A "still hidden" assertion passes just as happily when the script
		// never ran at all — a broken <script> tag, a renamed element id, a
		// throw before the fetch. Requiring the status request to have actually
		// gone out first means the hidden section below is the page CHOOSING to
		// stay hidden after a 404, not the page doing nothing.
		const statusRequested = page.waitForRequest(STATUS_URL, { timeout: 10000 });
		await page.goto(BASE_URL + '/');
		await statusRequested;
		// A fixed wait, not a locator wait: the assertion is that nothing ever
		// happens, and there is no event to await for that. 1.5 s is far more
		// than the intercepted 404 needs to resolve and reject, and well under
		// the page's 8 s fetch timeout and 5-minute error retry, so a section
		// still hidden here stays hidden.
		await page.waitForTimeout(1500);
		await expect(page.locator('#now-imaging')).toBeHidden();
	});

	test('@ci live: renders name, designation, caption, pulsing state; reserves the published frame box before the image loads', async ({ page }) => {
		// Park the frame JPEG. Released further down, after the reserved box has
		// been measured — see routeStatus's note on why the hold is load-bearing.
		const frameGate = deferred();
		await routeStatus(page, 'live', frameGate.promise);
		// domcontentloaded rather than the default 'load': the parked JPEG
		// response would otherwise keep the load event pending until release,
		// and page.goto would sit there until the test timeout. Every assertion
		// below is auto-retrying, so nothing needs the load event.
		await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded' });

		const section = page.locator('#now-imaging');
		await expect(section).toBeVisible();
		// is-live is what drives the pulsing dot in main.css; asserting the class
		// rather than an animation keeps the probe off Chromium's animation clock.
		await expect(section).toHaveClass(/is-live/);
		// A NEGATIVE check on the label, not `toHaveText('Currently imaging')`.
		// The static markup in index.njk already reads "Currently imaging", so
		// the positive form passes even if render() never touches the label —
		// it pins nothing. What this pair does pin is that the live branch did
		// not leave the idle wording behind. The label's JS authorship is
		// pinned by the idle probe below, whose expected text ("Last imaged ·
		// 6 hours ago") appears nowhere in the markup.
		await expect(page.locator('#now-imaging-label')).not.toHaveText(/^Last imaged/);
		await expect(page.locator('#now-name')).toHaveText('Veil Nebula');
		await expect(page.locator('#now-designation')).toHaveText('NGC 6960');
		// The fixture's filter "Ha", 300 s and 23 subs, rendered by
		// now-imaging-logic.js caption(): the Hα glyph and the ordinal are the
		// two parts of that string a refactor could plausibly break.
		await expect(page.locator('#now-caption')).toHaveText('Hα · 300 s · 23rd sub tonight');

		// No layout shift: render() sets #now-frame's aspect-ratio from
		// status.frame.width/height BEFORE it assigns the image src, so the box
		// is already the right shape when the JPEG arrives.
		//
		// scrollIntoViewIfNeeded first because the <img> is loading="lazy" —
		// off-screen it may never fetch, so the parked route would never be hit
		// and the load wait further down would burn its 10 s bound instead of
		// failing on the thing being measured.
		await page.locator('#now-frame').scrollIntoViewIfNeeded();
		const image = page.locator('#now-image');

		// Guard on the guard: prove the image really has no bytes yet, so a
		// future change that stops the hold from working (a different frame
		// URL, a route glob that no longer matches) turns into a failure here
		// rather than silently restoring the vacuous before/after comparison
		// this probe used to make. `complete` alone is not enough — an <img>
		// with no src at all also reports complete, and naturalWidth is what
		// separates that from a decoded frame.
		expect(
			await image.evaluate(img => img.complete && img.naturalWidth > 0),
			'the frame JPEG decoded before the reserved box could be measured',
		).toBe(false);

		const reserved = await page.locator('#now-frame').boundingBox();
		expect(reserved, '#now-frame must have a box before the image loads').toBeTruthy();
		// THE pin. With no image bytes the box's shape comes from CSS alone, and
		// there are only two candidates: render()'s inline aspect-ratio, or
		// main.css's 3/2 fallback when that assignment is missing. Separating
		// those two is the whole job of this assertion, and the only reason the
		// tolerance is as tight as it is (see FRAME_RATIO_TOLERANCE).
		expect(
			Math.abs(reserved.width / reserved.height - FRAME_RATIO) / FRAME_RATIO,
			'#now-frame did not reserve the published 785×526 box before the image loaded',
		).toBeLessThan(FRAME_RATIO_TOLERANCE);

		// Now let the bytes through and re-measure. Be clear about what this
		// second assertion can and cannot catch: as long as .now-frame has ANY
		// aspect-ratio its height is content-independent, so the 3/2 fallback
		// holds just as steady as the published ratio and this check alone
		// would not notice the deletion above. What it does catch is the box
		// losing its aspect-ratio outright — then the height comes from the
		// <img>, and 785×526 arriving over a 3×2 placeholder moves it.
		frameGate.release();
		await image.evaluate(
			img => img.complete || new Promise(resolve => { img.onload = resolve; }),
			undefined,
			{ timeout: 10000 },   // bounded: a frame that never loads fails here, it does not hang
		);
		const after = await page.locator('#now-frame').boundingBox();
		expect(after, '#now-frame must have a box after the image loads').toBeTruthy();
		// 1px tolerance for sub-pixel rounding of the aspect-ratio box.
		expect(Math.abs(reserved.height - after.height), 'frame box height moved when the image loaded')
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
