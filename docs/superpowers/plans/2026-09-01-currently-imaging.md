## Status (updated 2026-09-02)
Phase: 1 of 4 complete (Tasks 1–7 — the agent is built, unit-tested, and dry-run against the live rig)
Done: spec approved + committed (efee756); agent package, select/resolve/status/publish/backoff libs, socket + heartbeat loop, nina-probe tool, README; Task 7 dry run against the tailnet rig
Next: Task 8 (site markup — the homepage section and its script include)
Blocked: nothing for Phase 2; Phase 3 (infra + MeLe install) needs Dustin's go and an R2 token; Phase 4 first real light frame needs an imaging night

Dry run 2026-09-02: socket opened in 145 ms and subscribed to IMAGE-SAVE; heartbeat fired on schedule at t+300 s and ran clean (no `check failed`, confirmed by a connection-table instrument because a no-LIGHT check is silent by design); probe read 69 history entries with no LIGHT frame, camera idle, and decoded a prepared image at scale 0.4 to 2501x1670 at 675686 bytes.

# Currently Imaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A homepage section that shows the rig's current target, its latest single light frame, a caption, and a "What's this?" explainer, fed by a small event-driven agent on the MeLe that publishes two objects to a dedicated R2 bucket.

**Architecture:** Node agent on the MeLe subscribes to NINA's WebSocket image-saved event (5-minute heartbeat poll as fallback), fetches the newest LIGHT frame's stretched JPEG by history index, resolves the target name via Simbad (cached, overridable), and writes `now/sub-<utc>.jpg` then `now/status.json` to R2 bucket `dustinspace-live` (served at `live.dustin.space`). The homepage's `now-imaging.js` fetches `status.json` with `no-store`, renders the card, schedules its next fetch from `nextFrameExpectedAt`, and opens a native `<dialog>` explainer.

**Tech Stack:** Node 22 (built-in `fetch` + `WebSocket`), `@aws-sdk/client-s3` (R2), `node --test`, Eleventy 3 / Nunjucks, vanilla JS + CSS, Playwright (on-demand probes), Windows Scheduled Task on the MeLe.

**Spec:** `docs/superpowers/specs/2026-09-01-currently-imaging-design.md` — read it first; this plan argues from it. Section numbers below (§) refer to the spec.

## Global Constraints

- Node ≥ 22 on both Fedora (v22.22.2) and the MeLe (LTS 22 to be installed). No transpiler, no bundler. CommonJS in `now-imaging/` (matches `ingest/`), classic scripts in `src/assets/js/`.
- Indentation: tabs (project rule). Comments per the workspace Commenting Rules: every function gets a what/receives/returns header; every non-obvious choice gets a "why" comment; JS features beyond plain ES2020 get an inline explanation.
- Power of Ten: every loop bounded or commented "intentionally infinite"; every fetch has a timeout; every return value checked; no `eval`, no dynamic property dispatch.
- Privacy invariant (§7): `status.json` never contains keys matching `/lat|lon|long|site|elev|observer/i` at any depth. The profile endpoint is never called.
- Only NINA endpoints used: `GET /v2/api/image-history?all=true`, `GET /v2/api/image/{index}?resize=true&scale=S&quality=Q`, `GET /v2/api/equipment/camera/info`, `WS /v2/socket`.
- Publish order is image → status → delete-previous (§5.5). Never reversed.
- Homepage: section stays `hidden` until a valid status loads; never an error card (§6.2).
- CSP: `https://live.dustin.space` added to `img-src` and `connect-src` only (§6.4).
- Every new test pin is red-proven before commit (revert the guarded code, watch it fail).
- Bash tool shapes: one simple command per call; scripts go in files. Test runs on this workstation go through `bounded-run` (hook-enforced).
- Nothing is installed on the MeLe, and no bucket/token is created, without Dustin's explicit go (Phase 3).
- Commit messages end with the session's attribution trailer.

## File Structure

```
now-imaging/                         NEW package (own package.json + lockfile, no deps beyond @aws-sdk/client-s3; eslint dev-only)
  package.json
  eslint.config.js
  .gitignore                         config.json, state.json, resolve-cache.json, *.log, node_modules
  config.example.json                documented template
  overrides.json                     committed manual name overrides ({} to start)
  agent.js                           entry: wires socket + heartbeat + check()
  lib/select.js                      PURE selection math (latest LIGHT, subsTonight, nextFrameExpectedAt)
  lib/status.js                      PURE status builder + validator (privacy)
  lib/resolve.js                     name → {name, designation}; overrides → cache → Simbad TAP
  lib/nina.js                        NINA HTTP + socket client (fetch/WebSocket injectable)
  lib/publish.js                     R2 publish sequence (S3 client injectable) + dry-run
  lib/state.js                       state.json read/write
  lib/log.js                         append-only log, size-bounded rotation
  lib/backoff.js                     PURE debounce/backoff helpers used by agent.js
  install-task.ps1                   Windows Scheduled Task registration (commented for Dustin)
  README.md
tests/now-imaging/
  fixtures/history-2026-09-01.json   copied from ~/Claude/dustin-space-artifacts/now-imaging/
  fixtures/camera-info-2026-09-01.json
  select.test.js  status.test.js  resolve.test.js  nina.test.js  publish.test.js  backoff.test.js  logic.test.js
src/index.njk                        MODIFY: section between hero and Latest Captures; homePage: true front matter
src/_includes/layouts/base.njk       MODIFY: gated script includes for now-imaging-logic.js + now-imaging.js
src/_data/assetHash.js               MODIFY: two new keys
src/assets/js/now-imaging-logic.js   NEW: PURE liveness + schedule + caption logic (window.NowImagingLogic; node-testable)
src/assets/js/now-imaging.js         NEW: DOM wiring (fetch, render, timer, dialog)
src/assets/css/main.css              MODIFY: .now-imaging section + dialog styles
src/_headers                         MODIFY: CSP hosts
tests/build-smoke.test.js            MODIFY: new assertions
tests/headers.test.js                MODIFY: CSP host assertion
tests/probes/now-imaging.spec.js     NEW: on-demand Playwright probe with fixture status server
```

Phases: **1** agent core (Tasks 1–7) · **2** site (Tasks 8–12) · **3** infra + MeLe install (Tasks 13–14, Dustin-gated) · **4** first-night verification + QA (Task 15).

---

### Task 1: Agent package scaffold + `lib/select.js`

**Files:**
- Create: `now-imaging/package.json`, `now-imaging/.gitignore`, `now-imaging/eslint.config.js`, `now-imaging/config.example.json`, `now-imaging/overrides.json`, `now-imaging/lib/select.js`
- Create: `tests/now-imaging/fixtures/history-2026-09-01.json`, `tests/now-imaging/fixtures/camera-info-2026-09-01.json`, `tests/now-imaging/select.test.js`

**Interfaces:**
- Produces: `selectLatestLight(history) → {entry, index} | null`; `countSubsTonight(history, entry) → number`; `nextFrameExpectedAt(cameraInfo, nowMs, slackMs=15000) → string|null` (ISO UTC); `localNoonBefore(isoWithOffset) → Date`.

- [ ] **Step 1: Scaffold the package**

`now-imaging/package.json`:
```json
{
	"name": "dustin-space-now-imaging",
	"version": "0.1.0",
	"private": true,
	"description": "Publishes the rig's latest light frame + target to R2 for the dustin.space homepage",
	"main": "agent.js",
	"engines": { "node": ">=22" },
	"scripts": {
		"start": "node agent.js",
		"dry-run": "node agent.js --dry-run",
		"lint": "eslint ."
	},
	"dependencies": {
		"@aws-sdk/client-s3": "^3.1095.0"
	},
	"devDependencies": {
		"@eslint/js": "^9.0.0",
		"eslint": "^9.0.0"
	}
}
```
(`@aws-sdk/client-s3` pinned to the same major/minor floor as `ingest/package.json`.)

`now-imaging/.gitignore`:
```
node_modules/
config.json
state.json
resolve-cache.json
*.log
*.log.1
dry-run/
```

`now-imaging/eslint.config.js`:
```js
// Flat config (ESLint 9). Strict-recommended from day one (Power of Ten rule 10):
// the package ships warning-clean, and reviewers never burn a pass on lint.
'use strict';
const js = require('@eslint/js');
module.exports = [
	js.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'commonjs',
			globals: {
				// Node 22 built-ins used without imports.
				fetch: 'readonly', WebSocket: 'readonly', AbortSignal: 'readonly',
				Buffer: 'readonly', process: 'readonly', console: 'readonly',
				setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
				clearInterval: 'readonly', require: 'readonly', module: 'readonly', __dirname: 'readonly',
			},
		},
		rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
	},
];
```

`now-imaging/config.example.json`:
```json
{
	"_comment": "Copy to config.json (gitignored). Every key documented in README.md.",
	"ninaBaseUrl": "http://localhost:1888",
	"r2AccountId": "REPLACE",
	"r2AccessKeyId": "REPLACE",
	"r2SecretAccessKey": "REPLACE",
	"r2Bucket": "dustinspace-live",
	"publicBaseUrl": "https://live.dustin.space",
	"imageScale": 0.4,
	"jpegQuality": 80,
	"heartbeatSeconds": 300,
	"dryRunDir": null,
	"logPath": "now-imaging.log",
	"statePath": "state.json",
	"resolveCachePath": "resolve-cache.json"
}
```

`now-imaging/overrides.json`: `{}` with a one-line `_comment` key explaining the shape `{"<nina target name>": {"name": "...", "designation": "..."}}` (the resolver ignores keys starting with `_`).

Copy the fixtures:
```bash
mkdir -p tests/now-imaging/fixtures
cp ~/Claude/dustin-space-artifacts/now-imaging/history-2026-09-01.json tests/now-imaging/fixtures/
cp ~/Claude/dustin-space-artifacts/now-imaging/camera-info-2026-09-01.json tests/now-imaging/fixtures/
```

Then `cd now-imaging && npm install` (creates the lockfile; commit it).

- [ ] **Step 2: Write the failing tests**

`tests/now-imaging/select.test.js`:
```js
/**
 * tests/now-imaging/select.test.js — pins for the PURE selection math in
 * now-imaging/lib/select.js. Fixture = a real NINA image-history capture from
 * 2026-09-01 (69 entries, all SNAPSHOT bias/snapshot frames — no lights), plus
 * synthetic LIGHT entries appended per test so each pin controls its own data.
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const { selectLatestLight, countSubsTonight, nextFrameExpectedAt, localNoonBefore }
	= require('../../now-imaging/lib/select');

const FIX = path.join(__dirname, 'fixtures');
const history = JSON.parse(fs.readFileSync(path.join(FIX, 'history-2026-09-01.json'), 'utf8')).Response;
const cameraInfo = JSON.parse(fs.readFileSync(path.join(FIX, 'camera-info-2026-09-01.json'), 'utf8')).Response;

// Build a LIGHT entry shaped exactly like NINA's history rows.
function light(overrides) {
	return Object.assign({
		ExposureTime: 300, ImageType: 'LIGHT', Filter: 'Ha', RmsText: 'Tot: 0.40 (0.60")',
		Temperature: -5, CameraName: 'QHY268M', TargetName: 'Veil Nebula', Gain: 56, Offset: 11,
		Date: '2026-09-02T02:10:00.0000000-07:00', TelescopeName: 'Orion Eon 70', FocalLength: 350,
		StDev: 12.1, Mean: 410.2, Median: 402, Min: 12, Max: 65535, Stars: 412, HFR: 2.1,
		HFRStDev: '0.3', IsBayered: false,
		Filename: 'Orion Eon 70_Veil Nebula_2026-09-02_02-10-00_Ha_-5.00_300.00s_0023.xisf',
	}, overrides);
}

test('selectLatestLight: no LIGHT frames → null (real fixture is all SNAPSHOT)', () => {
	assert.equal(selectLatestLight(history), null);
});

test('selectLatestLight: picks the newest LIGHT by Date, not by array position', () => {
	const older  = light({ Date: '2026-09-02T02:10:00.0000000-07:00', Filename: 'a.xisf' });
	const newest = light({ Date: '2026-09-02T02:15:30.0000000-07:00', Filename: 'b.xisf' });
	const h = [...history, newest, older]; // newest deliberately BEFORE older in the array
	const picked = selectLatestLight(h);
	assert.equal(picked.entry.Filename, 'b.xisf');
	assert.equal(picked.index, history.length); // index = position in the array, for image/{index}
});

test('selectLatestLight: ImageType comparison is case-insensitive and ignores FLAT/DARK/BIAS', () => {
	const h = [...history, light({ ImageType: 'light', Filename: 'lc.xisf' }),
		light({ ImageType: 'FLAT', Date: '2026-09-02T03:00:00.0000000-07:00', Filename: 'flat.xisf' })];
	assert.equal(selectLatestLight(h).entry.Filename, 'lc.xisf');
});

test('countSubsTonight: counts same target+filter LIGHTs since the last local noon', () => {
	const h = [...history,
		light({ Date: '2026-09-01T23:50:00.0000000-07:00', Filename: '1.xisf' }), // same night, before midnight
		light({ Date: '2026-09-02T00:20:00.0000000-07:00', Filename: '2.xisf' }),
		light({ Date: '2026-09-02T02:10:00.0000000-07:00', Filename: '3.xisf' }),
		light({ Date: '2026-09-02T02:12:00.0000000-07:00', Filter: 'OIII', Filename: 'o.xisf' }), // other filter
		light({ Date: '2026-09-01T03:00:00.0000000-07:00', Filename: 'prev.xisf' }),            // previous night
	];
	const entry = h.find(e => e.Filename === '3.xisf');
	assert.equal(countSubsTonight(h, entry), 3);
});

test('localNoonBefore: uses the offset embedded in NINA\'s Date string, not the host zone', () => {
	// 00:20 local (-07:00) → previous local noon is 2026-09-01 12:00 -07:00 = 19:00Z
	assert.equal(localNoonBefore('2026-09-02T00:20:00.0000000-07:00').toISOString(), '2026-09-01T19:00:00.000Z');
	// 13:00 local → noon of the SAME day
	assert.equal(localNoonBefore('2026-09-02T13:00:00.0000000-07:00').toISOString(), '2026-09-02T19:00:00.000Z');
});

test('nextFrameExpectedAt: only when exposing; ExposureEndTime + slack, as UTC ISO', () => {
	// Real fixture: IsExposing=false → null
	assert.equal(nextFrameExpectedAt(cameraInfo, Date.now()), null);
	const exposing = Object.assign({}, cameraInfo, { IsExposing: true, ExposureEndTime: '2026-09-02T02:15:00.0000000-07:00' });
	assert.equal(nextFrameExpectedAt(exposing, Date.parse('2026-09-02T09:10:00Z')), '2026-09-02T09:15:15.000Z');
	// End time in the past (stale) → null, never a "next frame" in the past
	assert.equal(nextFrameExpectedAt(exposing, Date.parse('2026-09-02T09:20:00Z')), null);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bounded-run node --test tests/now-imaging/select.test.js`
Expected: FAIL, `Cannot find module '../../now-imaging/lib/select'`

- [ ] **Step 4: Implement `now-imaging/lib/select.js`**

```js
/**
 * select.js — PURE selection math over NINA's image-history array.
 *
 * Everything here is a plain function of its inputs (no I/O, no clock reads
 * except where `nowMs` is passed in) so it can be pinned with fixtures.
 *
 * NINA history rows (verified 2026-09-01) carry: ImageType, Filter, TargetName,
 * ExposureTime (s), Date (ISO string WITH the rig's UTC offset), Filename, etc.
 */
'use strict';

// Only LIGHT frames are ever published. Flats, darks, bias and snapshots are
// calibration/utility frames and must never appear on the homepage.
const LIGHT = 'light';

/**
 * selectLatestLight — find the newest LIGHT frame.
 * Receives the history array (as returned in NINA's `Response`).
 * Returns { entry, index } where `index` is the entry's POSITION in the array
 * (that index is what /v2/api/image/{index} takes), or null when no LIGHT exists.
 *
 * Why newest-by-Date rather than last-in-array: NINA appends in save order, but
 * we don't rely on that — the Date field is authoritative and the cost is one pass.
 */
function selectLatestLight(history) {
	if (!Array.isArray(history)) return null;
	let best = null;
	for (let i = 0; i < history.length; i++) {           // bounded: array length
		const e = history[i];
		if (!e || String(e.ImageType || '').toLowerCase() !== LIGHT) continue;
		const t = Date.parse(e.Date);
		if (!Number.isFinite(t)) continue;                 // unparseable date: skip, never throw
		if (best === null || t > best.t) best = { entry: e, index: i, t };
	}
	return best ? { entry: best.entry, index: best.index } : null;
}

/**
 * localNoonBefore — the most recent local noon at or before the given time.
 * Receives an ISO string carrying a UTC offset (e.g. "…-07:00"); returns a Date.
 *
 * Why parse the offset out of the string instead of using the host's zone:
 * this code runs on the MeLe (Arizona, no DST) during dev-from-Fedora (Seattle,
 * DST) too. The rig's own offset is embedded in every NINA Date, so "tonight"
 * is defined in the rig's clock regardless of where the agent runs.
 */
function localNoonBefore(isoWithOffset) {
	const m = /([+-])(\d{2}):(\d{2})$/.exec(isoWithOffset) || ['', '+', '00', '00'];
	const offsetMin = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
	const utcMs = Date.parse(isoWithOffset);
	// Shift into "local wall clock as if it were UTC", floor to the day, add 12h.
	const localMs = utcMs + offsetMin * 60000;
	const local = new Date(localMs);
	let noonLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 12);
	if (noonLocal > localMs) noonLocal -= 86400000;      // before noon today → yesterday's noon
	return new Date(noonLocal - offsetMin * 60000);       // back to real UTC
}

/**
 * countSubsTonight — how many LIGHT frames of the same target AND filter were
 * saved since the last local noon before `entry`'s Date (inclusive of entry).
 * Receives the history array and the selected entry; returns an integer.
 *
 * Why target+filter: "23rd Hα sub tonight" is the number an astronomer means;
 * mixing filters would inflate it. Why local noon: a night straddles midnight.
 */
function countSubsTonight(history, entry) {
	if (!Array.isArray(history) || !entry) return 0;
	const since = localNoonBefore(entry.Date).getTime();
	const until = Date.parse(entry.Date);
	let n = 0;
	for (const e of history) {                             // bounded: array length
		if (!e || String(e.ImageType || '').toLowerCase() !== LIGHT) continue;
		if (e.TargetName !== entry.TargetName || e.Filter !== entry.Filter) continue;
		const t = Date.parse(e.Date);
		if (Number.isFinite(t) && t >= since && t <= until) n++;
	}
	return n;
}

/**
 * nextFrameExpectedAt — when the exposure in progress should be on disk.
 * Receives NINA's camera/info Response, the current time in ms, and a slack in
 * ms (download + save + NINA bookkeeping; 15 s default). Returns an ISO UTC
 * string, or null when the camera is not exposing or the end time is missing,
 * unparseable, or already in the past (a stale timestamp from a previous frame).
 *
 * Verified 2026-09-01: camera/info exposes IsExposing + ExposureEndTime but no
 * duration field, which is why we publish an absolute time, not a length.
 */
function nextFrameExpectedAt(cameraInfo, nowMs, slackMs = 15000) {
	if (!cameraInfo || cameraInfo.IsExposing !== true) return null;
	const end = Date.parse(cameraInfo.ExposureEndTime);
	if (!Number.isFinite(end) || end <= nowMs) return null;
	return new Date(end + slackMs).toISOString();
}

module.exports = { selectLatestLight, countSubsTonight, nextFrameExpectedAt, localNoonBefore };
```

- [ ] **Step 5: Run tests → PASS; red-proof one pin**

Run: `bounded-run node --test tests/now-imaging/select.test.js` → all PASS.
Red-proof: change `t > best.t` to `t < best.t`, run, expect the "newest by Date" test to FAIL, revert.

- [ ] **Step 6: Lint + commit**

Run: `cd now-imaging && npx eslint .` → clean.
```bash
git add now-imaging/package.json now-imaging/package-lock.json now-imaging/.gitignore now-imaging/eslint.config.js now-imaging/config.example.json now-imaging/overrides.json now-imaging/lib/select.js tests/now-imaging/
git commit -m "now-imaging: package scaffold + pure selection math (select.js)"
```

---

### Task 2: `lib/status.js` — build + validate the status document

**Files:**
- Create: `now-imaging/lib/status.js`, `tests/now-imaging/status.test.js`

**Interfaces:**
- Consumes: `{entry}` from `selectLatestLight`, `countSubsTonight`, `nextFrameExpectedAt` (Task 1).
- Produces: `buildStatus({entry, subsTonight, nextFrameExpectedAt, resolved, frameUrl, width, height}) → object`; `validateStatus(obj) → {ok: true} | {ok: false, reason}`; `FORBIDDEN_KEY = /lat|lon|long|site|elev|observer/i`.

- [ ] **Step 1: Write the failing tests**

`tests/now-imaging/status.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { buildStatus, validateStatus } = require('../../now-imaging/lib/status');

const entry = {
	ExposureTime: 300, ImageType: 'LIGHT', Filter: 'Ha', TargetName: 'Veil Nebula',
	Date: '2026-09-02T02:10:00.0000000-07:00', CameraName: 'QHY268M',
	TelescopeName: 'Orion Eon 70', FocalLength: 350, Stars: 412, HFR: 2.1,
	Filename: 'x.xisf', Temperature: -5, Gain: 56,
};
const args = {
	entry, subsTonight: 23, nextFrameExpectedAt: '2026-09-02T09:15:15.000Z',
	resolved: { name: 'Veil Nebula', designation: 'NGC 6960' },
	frameUrl: 'https://live.dustin.space/now/sub-20260902T091000Z.jpg', width: 1256, height: 842,
};

test('buildStatus: shape matches spec §7, updatedAt is the frame Date in UTC', () => {
	const s = buildStatus(args);
	assert.equal(s.schemaVersion, 1);
	assert.equal(s.updatedAt, '2026-09-02T09:10:00.000Z');
	assert.equal(s.nextFrameExpectedAt, '2026-09-02T09:15:15.000Z');
	assert.deepEqual(s.target, { raw: 'Veil Nebula', name: 'Veil Nebula', designation: 'NGC 6960' });
	assert.deepEqual(s.frame, {
		url: args.frameUrl, width: 1256, height: 842, filter: 'Ha', exposureSeconds: 300,
		subsTonight: 23, hfr: 2.1, stars: 412,
	});
	assert.deepEqual(s.equipment, { camera: 'QHY268M', telescope: 'Orion Eon 70', focalLengthMm: 350 });
	assert.equal('filename' in s.frame, false, 'NINA filenames stay out of the public document');
});

test('buildStatus: omits nextFrameExpectedAt when null; null designation stays null', () => {
	const s = buildStatus(Object.assign({}, args, { nextFrameExpectedAt: null, resolved: { name: 'Foo', designation: null } }));
	assert.equal('nextFrameExpectedAt' in s, false);
	assert.equal(s.target.designation, null);
});

test('validateStatus: accepts a built status', () => {
	assert.deepEqual(validateStatus(buildStatus(args)), { ok: true });
});

test('validateStatus: rejects any coordinate-like key at any depth (privacy invariant)', () => {
	const s = buildStatus(args);
	s.equipment.siteLatitude = 31.9;          // planted
	const r = validateStatus(s);
	assert.equal(r.ok, false);
	assert.match(r.reason, /siteLatitude/);
	const s2 = buildStatus(args);
	s2.frame.meta = { observerElevation: 1500 };
	assert.equal(validateStatus(s2).ok, false);
});

test('validateStatus: rejects missing required fields and a non-https frame url', () => {
	const s = buildStatus(args);
	delete s.frame.url;
	assert.equal(validateStatus(s).ok, false);
	const s2 = buildStatus(Object.assign({}, args, { frameUrl: 'http://live.dustin.space/x.jpg' }));
	assert.equal(validateStatus(s2).ok, false);
});
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module '../../now-imaging/lib/status'`)

- [ ] **Step 3: Implement `now-imaging/lib/status.js`**

```js
/**
 * status.js — build and validate the public status document (spec §7).
 *
 * PURE: no I/O. `buildStatus` maps NINA fields to the public schema;
 * `validateStatus` is the last gate before publish and exists mainly to enforce
 * the PRIVACY INVARIANT: the document must never carry the observing site's
 * coordinates. NINA's own data model puts site lat/long right next to the
 * sky-pointing fields, so a future "just add the mount info" edit could leak
 * ground coordinates by accident — this check makes that a hard failure.
 */
'use strict';

// Any key matching this, at any depth, fails validation. Deliberately broad
// (matches "longitude", "sitelat", "elevation", "observer…"): a false positive
// costs a rename; a false negative costs the content policy.
const FORBIDDEN_KEY = /lat|lon|long|site|elev|observer/i;

// Maximum nesting we will walk. The schema is 2 deep; 8 is a generous bound so
// a pathological object can't recurse forever (Power of Ten rule 1).
const MAX_DEPTH = 8;

/**
 * buildStatus — assemble the status document.
 * Receives: entry (NINA history row), subsTonight (int), nextFrameExpectedAt
 * (ISO string or null), resolved ({name, designation|null}), frameUrl (https
 * URL of the uploaded JPEG), width/height (px of that JPEG).
 * Returns a plain object ready for JSON.stringify. Never throws on odd input;
 * validateStatus is where rejection happens.
 */
function buildStatus({ entry, subsTonight, nextFrameExpectedAt, resolved, frameUrl, width, height }) {
	const status = {
		schemaVersion: 1,
		// The frame's own timestamp, not publish time: liveness on the page is
		// "how old is the newest frame", and publish lag would lie about that.
		updatedAt: new Date(Date.parse(entry.Date)).toISOString(),
	};
	if (nextFrameExpectedAt) status.nextFrameExpectedAt = nextFrameExpectedAt;
	status.target = {
		raw: String(entry.TargetName || ''),
		name: String(resolved && resolved.name || entry.TargetName || ''),
		designation: resolved && resolved.designation ? String(resolved.designation) : null,
	};
	status.frame = {
		url: frameUrl,
		width, height,
		filter: String(entry.Filter || ''),
		exposureSeconds: Number(entry.ExposureTime),
		subsTonight: Number(subsTonight) || 0,
		// Published but not rendered (Dustin chose the lighter caption); keeps a
		// denser caption a page-only change later.
		hfr: Number.isFinite(Number(entry.HFR)) ? Number(entry.HFR) : null,
		stars: Number.isFinite(Number(entry.Stars)) && Number(entry.Stars) >= 0 ? Number(entry.Stars) : null,
	};
	status.equipment = {
		camera: String(entry.CameraName || ''),
		telescope: String(entry.TelescopeName || ''),
		focalLengthMm: Number.isFinite(Number(entry.FocalLength)) ? Number(entry.FocalLength) : null,
	};
	return status;
}

/**
 * findForbiddenKey — depth-first walk for a key matching FORBIDDEN_KEY.
 * Receives any value and the current depth; returns the offending key path or null.
 */
function findForbiddenKey(value, depth, prefix) {
	if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return null;
	for (const key of Object.keys(value)) {               // bounded: object keys
		const here = prefix ? `${prefix}.${key}` : key;
		if (FORBIDDEN_KEY.test(key)) return here;
		const inner = findForbiddenKey(value[key], depth + 1, here);
		if (inner) return inner;
	}
	return null;
}

/**
 * validateStatus — the publish gate.
 * Receives a status object; returns {ok:true} or {ok:false, reason}.
 * Checks: schemaVersion 1, ISO updatedAt, https frame url, numeric exposure,
 * a non-empty target name, and the privacy invariant.
 */
function validateStatus(s) {
	if (!s || typeof s !== 'object') return { ok: false, reason: 'not an object' };
	if (s.schemaVersion !== 1) return { ok: false, reason: 'schemaVersion must be 1' };
	if (!Number.isFinite(Date.parse(s.updatedAt))) return { ok: false, reason: 'updatedAt not parseable' };
	if (!s.target || !s.target.name) return { ok: false, reason: 'target.name missing' };
	if (!s.frame || typeof s.frame.url !== 'string' || !/^https:\/\//.test(s.frame.url)) {
		return { ok: false, reason: 'frame.url missing or not https' };
	}
	if (!Number.isFinite(s.frame.exposureSeconds)) return { ok: false, reason: 'frame.exposureSeconds not numeric' };
	const bad = findForbiddenKey(s, 0, '');
	if (bad) return { ok: false, reason: `forbidden key "${bad}" (privacy invariant, spec §7)` };
	return { ok: true };
}

module.exports = { buildStatus, validateStatus, FORBIDDEN_KEY };
```

- [ ] **Step 4: Run → PASS; red-proof:** comment out the `findForbiddenKey` call, expect the privacy test to FAIL, restore.

- [ ] **Step 5: Commit**
```bash
git add now-imaging/lib/status.js tests/now-imaging/status.test.js
git commit -m "now-imaging: status builder + privacy-invariant validator"
```

---

### Task 3: `lib/resolve.js` — target name → colloquial name + designation

**Files:**
- Create: `now-imaging/lib/resolve.js`, `tests/now-imaging/resolve.test.js`

**Interfaces:**
- Produces: `createResolver({overrides, cachePath, fetchImpl, timeoutMs}) → { resolve(rawName) → Promise<{name, designation}> }`; `pickFromIds(rawName, mainId, idsPipeString) → {name, designation}` (PURE); `normalizeKey(s) → string`; `CATALOG_PRIORITY` (array of regexes).

Verified 2026-09-01: Simbad TAP `SELECT b.main_id, i.ids FROM basic b JOIN ids i ON i.oidref=b.oid JOIN ident d ON d.oidref=b.oid WHERE d.id='Veil Nebula'` returns `["NGC  6960", "LBN   191|LBN 074.53-08.42|NAME Cirrus Nebula|NAME Filamentary Nebula|NGC  6960|NAME Veil Nebula"]` (note the double-space padding inside identifiers). Same for `d.id='NGC 6960'`.

- [ ] **Step 1: Write the failing tests**

`tests/now-imaging/resolve.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');
const { createResolver, pickFromIds, normalizeKey } = require('../../now-imaging/lib/resolve');

const VEIL_IDS = 'LBN   191|LBN 074.53-08.42|NAME Cirrus Nebula|NAME Filamentary Nebula|NGC  6960|NAME Veil Nebula';

test('normalizeKey: case-insensitive, whitespace-collapsed', () => {
	assert.equal(normalizeKey('  veil   NEBULA '), 'veil nebula');
	assert.equal(normalizeKey('NGC  6960'), 'ngc 6960');
});

test('pickFromIds: raw is a NAME → that name (Simbad casing), designation by catalog priority', () => {
	assert.deepEqual(pickFromIds('veil nebula', 'NGC  6960', VEIL_IDS), { name: 'Veil Nebula', designation: 'NGC 6960' });
});

test('pickFromIds: raw is a designation → first NAME entry becomes the name', () => {
	assert.deepEqual(pickFromIds('NGC 6960', 'NGC  6960', VEIL_IDS), { name: 'Cirrus Nebula', designation: 'NGC 6960' });
});

test('pickFromIds: Messier beats NGC; no NAME entry → name is the designation', () => {
	const ids = 'NGC  1976|M  42|LBN   974';
	assert.deepEqual(pickFromIds('orion', 'M  42', ids), { name: 'M 42', designation: 'M 42' });
});

test('pickFromIds: nothing in the priority list → designation is main_id, whitespace-normalized', () => {
	assert.deepEqual(pickFromIds('x', 'Cl Melotte   20', 'Cl Melotte   20|NAME Alpha Persei Cluster'),
		{ name: 'Alpha Persei Cluster', designation: 'Cl Melotte 20' });
});

function tmpCache() {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-')), 'cache.json');
}

test('resolve: override wins and never touches the network', async () => {
	let calls = 0;
	const r = createResolver({
		overrides: { 'Veil Nebula': { name: 'Veil Nebula (West)', designation: 'NGC 6960' } },
		cachePath: tmpCache(), fetchImpl: async () => { calls++; throw new Error('no network'); },
	});
	assert.deepEqual(await r.resolve('veil nebula'), { name: 'Veil Nebula (West)', designation: 'NGC 6960' });
	assert.equal(calls, 0);
});

test('resolve: Simbad hit is cached to disk; second call skips the network', async () => {
	let calls = 0;
	const fetchImpl = async () => {
		calls++;
		return { ok: true, json: async () => ({ data: [['NGC  6960', VEIL_IDS]] }) };
	};
	const cachePath = tmpCache();
	const r = createResolver({ overrides: {}, cachePath, fetchImpl });
	assert.deepEqual(await r.resolve('Veil Nebula'), { name: 'Veil Nebula', designation: 'NGC 6960' });
	assert.equal(calls, 1);
	const r2 = createResolver({ overrides: {}, cachePath, fetchImpl });
	assert.deepEqual(await r2.resolve('veil  nebula'), { name: 'Veil Nebula', designation: 'NGC 6960' });
	assert.equal(calls, 1, 'second resolver instance must read the disk cache');
});

test('resolve: Simbad failure or empty result → raw name, null designation, NOT cached', async () => {
	const cachePath = tmpCache();
	const r = createResolver({ overrides: {}, cachePath, fetchImpl: async () => ({ ok: false, status: 503 }) });
	assert.deepEqual(await r.resolve('Mystery Blob'), { name: 'Mystery Blob', designation: null });
	assert.equal(fs.existsSync(cachePath) ? Object.keys(JSON.parse(fs.readFileSync(cachePath, 'utf8'))).length : 0, 0);
	const r2 = createResolver({ overrides: {}, cachePath, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) });
	assert.deepEqual(await r2.resolve('Mystery Blob'), { name: 'Mystery Blob', designation: null });
});

test('resolve: the ADQL escapes a single quote in the raw name', async () => {
	let url = '';
	const r = createResolver({ overrides: {}, cachePath: tmpCache(), fetchImpl: async (u) => { url = String(u); return { ok: true, json: async () => ({ data: [] }) }; } });
	await r.resolve("Barnard's Loop");
	assert.match(decodeURIComponent(url), /Barnard''s Loop/);
});
```

- [ ] **Step 2: Run → FAIL** (module missing)

- [ ] **Step 3: Implement `now-imaging/lib/resolve.js`**

```js
/**
 * resolve.js — turn NINA's freeform target string into the two names the card
 * shows: a colloquial name and ONE catalog designation (spec §5.4).
 *
 * Order: overrides.json → disk cache → Simbad TAP. Simbad failure never blocks
 * publishing: the card then shows the raw name with no designation.
 *
 * Simbad's `ident` table matches freeform forms ("Veil Nebula", "NGC 6960")
 * directly — verified 2026-09-01 with the exact query below. Identifiers come
 * back with internal padding ("NGC  6960"); we collapse whitespace on output.
 */
'use strict';

const fs = require('node:fs');

const SIMBAD_TAP = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync';

// Catalog priority for the ONE designation shown — the library naming
// convention (2026-05-27): Messier > Caldwell > NGC > IC > Sharpless > Barnard >
// LBN/LDN > vdB > Arp > HCG > Abell > UGC/MCG/ESO/PGC. Each regex is tested
// against a whitespace-normalized identifier. Order is the priority.
const CATALOG_PRIORITY = [
	/^M \d+$/i, /^C \d+$/i, /^NGC \d+[A-Z]?$/i, /^IC \d+[A-Z]?$/i, /^SH 2-\d+$/i, /^Barnard \d+$/i,
	/^LBN \d+$/i, /^LDN \d+$/i, /^VdB \d+$/i, /^APG \d+$/i, /^Arp \d+$/i, /^HCG \d+$/i, /^ACO \d+$/i,
	/^UGC \d+$/i, /^MCG[ +-]/i, /^ESO \d+-\d+$/i, /^LEDA \d+$/i,
];

/**
 * normalizeKey — canonical form for matching names: lowercase, single spaces, trimmed.
 * Receives a string; returns a string.
 */
function normalizeKey(s) {
	return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** tidy — collapse Simbad's internal padding ("NGC  6960" → "NGC 6960"). */
function tidy(s) {
	return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * pickFromIds — PURE choice of {name, designation} from a Simbad ids list.
 * Receives the raw NINA name, Simbad's main_id, and the pipe-joined ids string.
 * Returns {name, designation}.
 *
 * name: if the raw string IS one of the "NAME …" aliases, use that alias with
 * Simbad's casing (so "veil nebula" → "Veil Nebula"); otherwise the first NAME
 * alias in Simbad's list (their order is not curated — "Cirrus Nebula" precedes
 * "Veil Nebula" — which is exactly what overrides.json is for); otherwise the
 * designation itself.
 * designation: first identifier matching CATALOG_PRIORITY, in priority order;
 * else main_id.
 */
function pickFromIds(rawName, mainId, idsPipe) {
	const ids = String(idsPipe || '').split('|').map(tidy).filter(Boolean);
	const names = ids.filter(id => /^NAME /i.test(id)).map(id => id.replace(/^NAME /i, ''));
	const rawKey = normalizeKey(rawName);

	let designation = null;
	for (const re of CATALOG_PRIORITY) {                   // bounded: fixed list
		const hit = ids.find(id => re.test(id));
		if (hit) { designation = hit; break; }
	}
	if (!designation) designation = tidy(mainId) || null;

	let name = names.find(n => normalizeKey(n) === rawKey) || names[0] || designation;
	return { name, designation };
}

/**
 * createResolver — factory holding overrides + cache + network.
 * Receives: overrides (object from overrides.json), cachePath (file, may not
 * exist yet), fetchImpl (defaults to global fetch; tests inject a fake),
 * timeoutMs (Simbad timeout, default 8000).
 * Returns { resolve(rawName) }.
 */
function createResolver({ overrides = {}, cachePath, fetchImpl = fetch, timeoutMs = 8000 }) {
	// Overrides keyed by normalized name; keys starting with "_" are comments.
	const over = {};
	for (const [k, v] of Object.entries(overrides)) if (!k.startsWith('_')) over[normalizeKey(k)] = v;

	let cache = {};
	try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { cache = {}; }

	function saveCache() {
		try { fs.writeFileSync(cachePath, JSON.stringify(cache, null, '\t')); }
		catch (err) { console.warn('[resolve] cache write failed:', err.message); }   // non-fatal by design
	}

	/**
	 * querySimbad — one TAP round-trip. Receives the raw name; returns
	 * [main_id, ids] or null on any failure (HTTP, timeout, empty, malformed).
	 * ADQL string literal: single quotes are escaped by doubling.
	 */
	async function querySimbad(rawName) {
		const lit = String(rawName).replace(/'/g, "''");
		const adql = `SELECT b.main_id, i.ids FROM basic b JOIN ids i ON i.oidref=b.oid JOIN ident d ON d.oidref=b.oid WHERE d.id='${lit}'`;
		const url = new URL(SIMBAD_TAP);
		url.searchParams.set('request', 'doQuery');
		url.searchParams.set('lang', 'adql');
		url.searchParams.set('format', 'json');
		url.searchParams.set('query', adql);
		try {
			const resp = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(timeoutMs) });
			if (!resp.ok) return null;
			const body = await resp.json();
			const row = body && Array.isArray(body.data) && body.data[0];
			return row && row.length >= 2 ? [String(row[0]), String(row[1])] : null;
		} catch {
			return null;                                       // caller logs; publishing continues
		}
	}

	/**
	 * resolve — the public entry. Receives NINA's raw target name; returns
	 * Promise<{name, designation}>. Never rejects.
	 */
	async function resolve(rawName) {
		const key = normalizeKey(rawName);
		if (!key) return { name: String(rawName || ''), designation: null };
		if (over[key]) return { name: String(over[key].name || rawName), designation: over[key].designation || null };
		if (cache[key]) return cache[key];
		const row = await querySimbad(rawName);
		if (!row) return { name: String(rawName), designation: null };   // deliberately NOT cached: retry next target
		const picked = pickFromIds(rawName, row[0], row[1]);
		cache[key] = picked;
		saveCache();
		return picked;
	}

	return { resolve };
}

module.exports = { createResolver, pickFromIds, normalizeKey, CATALOG_PRIORITY };
```

- [ ] **Step 4: Run → PASS; red-proof:** swap the `M \d+` and `NGC` regexes' order, expect the Messier-beats-NGC test to FAIL, restore.

- [ ] **Step 5: Live spot-check from Fedora (network, read-only)**

Write `now-imaging/tools/resolve-probe.js` (committed; useful later for seeding overrides):
```js
// Usage: node tools/resolve-probe.js "Veil Nebula" — prints what the card would show.
'use strict';
const path = require('node:path');
const { createResolver } = require('../lib/resolve');
const r = createResolver({ overrides: require('../overrides.json'), cachePath: path.join(__dirname, '..', 'resolve-cache.json') });
r.resolve(process.argv[2] || 'Veil Nebula').then(x => console.log(JSON.stringify(x)));
```
Run: `node now-imaging/tools/resolve-probe.js "Veil Nebula"` → `{"name":"Veil Nebula","designation":"NGC 6960"}`. Also try `"M 27"`, `"Crescent Nebula"`, `"IC 1396"`; note any surprising picks in the README's overrides section.

- [ ] **Step 6: Commit**
```bash
git add now-imaging/lib/resolve.js now-imaging/tools/resolve-probe.js tests/now-imaging/resolve.test.js
git commit -m "now-imaging: Simbad-backed target name resolver with overrides + disk cache"
```

---

### Task 4: `lib/nina.js` — NINA HTTP + socket client

**Files:**
- Create: `now-imaging/lib/nina.js`, `tests/now-imaging/nina.test.js`

**Interfaces:**
- Produces: `createNina({baseUrl, fetchImpl, WebSocketImpl, timeoutMs}) → { history(), imageByIndex(index, scale, quality), cameraInfo(), openSocket(onImageSaved, onStateChange) → {close()} }`; `decodeImageResponse(body, maxBytes) → Buffer` (PURE); `jpegDimensions(buf) → {width,height}|null` (PURE).

Verified 2026-09-01: `image/{index}` returns JSON `{Response: "<base64>", Success, Error, StatusCode}`; the socket subscribe message is `{"action":"subscribe","eventType":"IMAGE-SAVE"}` and events arrive as `{Response: {Event: "IMAGE-SAVE", ...}}` (per Touch'N'Stars `store.js:1121`; payload unverified live — the heartbeat covers a mismatch).

- [ ] **Step 1: Write the failing tests**

`tests/now-imaging/nina.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { createNina, decodeImageResponse, jpegDimensions } = require('../../now-imaging/lib/nina');

// A 1x1 baseline JPEG (smallest valid), as base64. Dimensions live in the SOF0 segment.
const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';

test('decodeImageResponse: base64 Response → Buffer starting with the JPEG magic', () => {
	const buf = decodeImageResponse({ Response: TINY_JPEG_B64, Success: true }, 1024 * 1024);
	assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8);
});

test('decodeImageResponse: rejects non-JPEG bytes, oversize payloads, and error responses', () => {
	assert.throws(() => decodeImageResponse({ Response: Buffer.from('not a jpeg').toString('base64') }, 1e6), /not a JPEG/);
	assert.throws(() => decodeImageResponse({ Response: TINY_JPEG_B64 }, 10), /exceeds/);
	assert.throws(() => decodeImageResponse({ Success: false, Error: 'no image' }, 1e6), /no image/);
});

test('jpegDimensions: reads width/height from SOF0', () => {
	const buf = Buffer.from(TINY_JPEG_B64, 'base64');
	assert.deepEqual(jpegDimensions(buf), { width: 1, height: 1 });
	assert.equal(jpegDimensions(Buffer.from('zz')), null);
});

test('history/cameraInfo/imageByIndex hit the documented URLs with a timeout signal', async () => {
	const seen = [];
	const fetchImpl = async (url, opts) => {
		seen.push({ url: String(url), hasSignal: !!(opts && opts.signal) });
		if (/image-history/.test(url)) return { ok: true, json: async () => ({ Response: [{ ImageType: 'LIGHT' }] }) };
		if (/camera\/info/.test(url))   return { ok: true, json: async () => ({ Response: { IsExposing: false } }) };
		if (/\/image\/7\?/.test(url))   return { ok: true, json: async () => ({ Response: TINY_JPEG_B64, Success: true }) };
		return { ok: false, status: 404 };
	};
	const nina = createNina({ baseUrl: 'http://localhost:1888', fetchImpl });
	assert.deepEqual(await nina.history(), [{ ImageType: 'LIGHT' }]);
	assert.deepEqual(await nina.cameraInfo(), { IsExposing: false });
	const buf = await nina.imageByIndex(7, 0.4, 80);
	assert.equal(buf[0], 0xff);
	assert.equal(seen[0].url, 'http://localhost:1888/v2/api/image-history?all=true');
	assert.equal(seen[1].url, 'http://localhost:1888/v2/api/equipment/camera/info');
	assert.equal(seen[2].url, 'http://localhost:1888/v2/api/image/7?resize=true&scale=0.4&quality=80');
	assert.ok(seen.every(s => s.hasSignal), 'every request carries an abort signal (timeout)');
});

test('history: non-200 or non-array Response → throws with the status in the message', async () => {
	const nina = createNina({ baseUrl: 'http://x', fetchImpl: async () => ({ ok: false, status: 503 }) });
	await assert.rejects(nina.history(), /503/);
	const nina2 = createNina({ baseUrl: 'http://x', fetchImpl: async () => ({ ok: true, json: async () => ({ Response: 'nope' }) }) });
	await assert.rejects(nina2.history(), /not an array/);
});

test('openSocket: subscribes to IMAGE-SAVE on open and forwards only IMAGE-SAVE events', () => {
	const sent = [];
	class FakeWS {
		constructor(url) { this.url = url; this.listeners = {}; FakeWS.last = this; }
		addEventListener(type, fn) { this.listeners[type] = fn; }
		send(msg) { sent.push(msg); }
		close() { this.closed = true; }
		emit(type, ev) { this.listeners[type] && this.listeners[type](ev); }
	}
	const saved = []; const states = [];
	const nina = createNina({ baseUrl: 'http://host:1888', WebSocketImpl: FakeWS });
	const sock = nina.openSocket(() => saved.push(1), s => states.push(s));
	assert.equal(FakeWS.last.url, 'ws://host:1888/v2/socket');
	FakeWS.last.emit('open', {});
	assert.deepEqual(JSON.parse(sent[0]), { action: 'subscribe', eventType: 'IMAGE-SAVE' });
	FakeWS.last.emit('message', { data: JSON.stringify({ Response: { Event: 'IMAGE-PREPARED' } }) });
	FakeWS.last.emit('message', { data: JSON.stringify({ Response: { Event: 'IMAGE-SAVE' } }) });
	FakeWS.last.emit('message', { data: 'garbage{' });        // must not throw
	assert.equal(saved.length, 1);
	FakeWS.last.emit('close', { code: 1006 });
	assert.deepEqual(states, ['open', 'closed']);
	sock.close();
	assert.equal(FakeWS.last.closed, true);
});
```

- [ ] **Step 2: Run → FAIL** (module missing)

- [ ] **Step 3: Implement `now-imaging/lib/nina.js`**

```js
/**
 * nina.js — the only code that talks to NINA's Advanced API.
 *
 * Exactly four surfaces (spec Global Constraints): image-history, image/{index},
 * equipment/camera/info, and the /v2/socket event stream. The profile endpoint
 * (which carries the observing site's coordinates) is deliberately absent.
 *
 * fetch and WebSocket are INJECTABLE (defaults are Node 22's built-ins) so the
 * tests drive this module without a network.
 */
'use strict';

const JPEG_MAGIC = [0xff, 0xd8];

/**
 * decodeImageResponse — turn NINA's image/{index} JSON into JPEG bytes.
 * Receives the parsed body ({Response: base64, Success, Error}) and a byte cap.
 * Returns a Buffer. Throws (with NINA's own Error text when present) on an API
 * error, non-JPEG bytes, or a payload over the cap — a cap because a scale
 * misconfiguration could otherwise ship a multi-megabyte frame to R2 every sub.
 */
function decodeImageResponse(body, maxBytes) {
	if (!body || typeof body.Response !== 'string') {
		throw new Error(`NINA image error: ${body && body.Error ? body.Error : 'no image data in response'}`);
	}
	const buf = Buffer.from(body.Response, 'base64');
	if (buf.length > maxBytes) throw new Error(`image ${buf.length} bytes exceeds cap ${maxBytes}`);
	if (buf[0] !== JPEG_MAGIC[0] || buf[1] !== JPEG_MAGIC[1]) throw new Error('image is not a JPEG');
	return buf;
}

/**
 * jpegDimensions — width/height from the first SOF marker (0xFFC0..0xFFC3).
 * Receives a Buffer; returns {width, height} or null if no SOF is found within
 * the buffer. Walks JPEG segments (each: 0xFF, marker, 2-byte length); bounded
 * by the buffer length. Used so status.json can carry the aspect ratio and the
 * page can reserve the box before the image loads (no layout shift).
 */
function jpegDimensions(buf) {
	if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
	let i = 2;
	while (i + 9 < buf.length) {                           // bounded: buffer length
		if (buf[i] !== 0xff) { i++; continue; }
		const marker = buf[i + 1];
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { i += 2; continue; }
		const len = buf.readUInt16BE(i + 2);
		if (marker >= 0xc0 && marker <= 0xc3) {
			return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
		}
		i += 2 + len;
	}
	return null;
}

/**
 * createNina — client factory.
 * Receives baseUrl (e.g. http://localhost:1888), optional fetchImpl /
 * WebSocketImpl (tests), timeoutMs per HTTP call (default 10 s), maxImageBytes
 * (default 3 MB). Returns the client object documented in the plan interfaces.
 */
function createNina({ baseUrl, fetchImpl = fetch, WebSocketImpl = WebSocket, timeoutMs = 10000, maxImageBytes = 3 * 1024 * 1024 }) {
	const base = String(baseUrl).replace(/\/+$/, '');

	/** getJson — one GET with timeout; returns the parsed body or throws with the HTTP status. */
	async function getJson(pathAndQuery) {
		const resp = await fetchImpl(`${base}${pathAndQuery}`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!resp.ok) throw new Error(`NINA ${pathAndQuery} → HTTP ${resp.status}`);
		return resp.json();
	}

	/** history — the full image history array for this NINA process. */
	async function history() {
		const body = await getJson('/v2/api/image-history?all=true');
		if (!body || !Array.isArray(body.Response)) throw new Error('NINA image-history Response is not an array');
		return body.Response;
	}

	/** cameraInfo — camera/info Response object (IsExposing, ExposureEndTime, …). */
	async function cameraInfo() {
		const body = await getJson('/v2/api/equipment/camera/info');
		if (!body || typeof body.Response !== 'object') throw new Error('NINA camera/info Response missing');
		return body.Response;
	}

	/**
	 * imageByIndex — stretched JPEG of history entry `index`.
	 * scale is a 0–1 FRACTION of NINA's prepared image (verified 2026-09-01:
	 * 0.25 → 785 px from a 3140 px prepared image); quality is JPEG 1–100.
	 * Fetching BY INDEX (not prepared-image) is race-free: a snapshot or flat
	 * landing between the history read and this call cannot swap the frame.
	 */
	async function imageByIndex(index, scale, quality) {
		const body = await getJson(`/v2/api/image/${index}?resize=true&scale=${scale}&quality=${quality}`);
		return decodeImageResponse(body, maxImageBytes);
	}

	/**
	 * openSocket — subscribe to IMAGE-SAVE events.
	 * Receives onImageSaved() and onStateChange('open'|'closed'|'error').
	 * Returns {close()}. Reconnection is the CALLER's job (agent.js owns the
	 * backoff so it can log and so the policy is testable in one place).
	 */
	function openSocket(onImageSaved, onStateChange) {
		const wsUrl = base.replace(/^http/, 'ws') + '/v2/socket';
		const ws = new WebSocketImpl(wsUrl);
		ws.addEventListener('open', () => {
			ws.send(JSON.stringify({ action: 'subscribe', eventType: 'IMAGE-SAVE' }));
			onStateChange('open');
		});
		ws.addEventListener('message', (ev) => {
			let msg = null;
			try { msg = JSON.parse(String(ev.data)); } catch { return; }   // unknown frame: ignore, never throw
			if (msg && msg.Response && msg.Response.Event === 'IMAGE-SAVE') onImageSaved();
		});
		ws.addEventListener('error', () => onStateChange('error'));
		ws.addEventListener('close', () => onStateChange('closed'));
		return { close: () => ws.close() };
	}

	return { history, cameraInfo, imageByIndex, openSocket };
}

module.exports = { createNina, decodeImageResponse, jpegDimensions };
```

- [ ] **Step 4: Run → PASS; red-proof:** remove the `JPEG_MAGIC` check, expect the "rejects non-JPEG" test to FAIL, restore.

- [ ] **Step 5: Live probe from Fedora (read-only):** `node -e` is blocked by the shell-shape rule, so add `now-imaging/tools/nina-probe.js`:
```js
// Usage: node tools/nina-probe.js http://100.106.198.18:1888 — prints history count, newest LIGHT, camera state.
'use strict';
const { createNina, jpegDimensions } = require('../lib/nina');
const { selectLatestLight } = require('../lib/select');
(async () => {
	const nina = createNina({ baseUrl: process.argv[2] || 'http://localhost:1888' });
	const h = await nina.history();
	const pick = selectLatestLight(h);
	console.log('history entries:', h.length, 'newest LIGHT:', pick ? pick.entry.Filename : 'none');
	const cam = await nina.cameraInfo();
	console.log('camera: exposing =', cam.IsExposing, 'end =', cam.ExposureEndTime);
	const idx = pick ? pick.index : h.length - 1;          // fall back to the newest ANY frame just to exercise decode
	const buf = await nina.imageByIndex(idx, 0.4, 80);
	console.log('image bytes:', buf.length, 'dims:', JSON.stringify(jpegDimensions(buf)));
})().catch(err => { console.error('probe failed:', err.message); process.exit(1); });
```
Run: `node now-imaging/tools/nina-probe.js http://100.106.198.18:1888` → prints counts; expect `newest LIGHT: none` until a real night, image bytes from the bias frame, dims ≈ 1256×842.

- [ ] **Step 6: Commit**
```bash
git add now-imaging/lib/nina.js now-imaging/tools/nina-probe.js tests/now-imaging/nina.test.js
git commit -m "now-imaging: NINA client (history, image-by-index, camera info, IMAGE-SAVE socket)"
```

---

### Task 5: `lib/publish.js` + `lib/state.js` — R2 publish sequence with dry-run

**Files:**
- Create: `now-imaging/lib/publish.js`, `now-imaging/lib/state.js`, `tests/now-imaging/publish.test.js`

**Interfaces:**
- Produces: `createPublisher({s3, bucket, publicBaseUrl, dryRunDir}) → { publish({jpegBuffer, status, prevKey, pendingDelete}) → Promise<{key, url, deleted:[], pendingDelete:[]}> }`; `keyForFrame(updatedAtIso) → 'now/sub-YYYYMMDDTHHMMSSZ.jpg'`; `createState(path) → { load() → {lastFilename, lastKey, pendingDelete}, save(obj) }`.

Note: `publish` receives the status WITHOUT `frame.url` filled and fills it (the URL derives from the key this call chooses). The caller then validates. Order: PUT jpg → PUT status → DELETE previous keys.

- [ ] **Step 1: Write the failing tests**

`tests/now-imaging/publish.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');
const { createPublisher, keyForFrame } = require('../../now-imaging/lib/publish');
const { createState } = require('../../now-imaging/lib/state');

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const baseStatus = () => ({ schemaVersion: 1, updatedAt: '2026-09-02T09:10:00.000Z', frame: { url: null } });

// Fake S3 client: records every command in order; optional failure injection by command name.
function fakeS3(failOn) {
	const calls = [];
	return {
		calls,
		send: async (cmd) => {
			calls.push({ name: cmd.constructor.name, input: cmd.input });
			if (failOn && failOn(cmd)) throw new Error(`injected ${cmd.constructor.name} failure`);
			return {};
		},
	};
}

test('keyForFrame: versioned key from the frame timestamp', () => {
	assert.equal(keyForFrame('2026-09-02T09:10:00.000Z'), 'now/sub-20260902T091000Z.jpg');
});

test('publish: image → status → delete-previous, with the right metadata', async () => {
	const s3 = fakeS3();
	const p = createPublisher({ s3, bucket: 'dustinspace-live', publicBaseUrl: 'https://live.dustin.space' });
	const r = await p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: 'now/sub-old.jpg', pendingDelete: [] });
	assert.deepEqual(s3.calls.map(c => c.name), ['PutObjectCommand', 'PutObjectCommand', 'DeleteObjectCommand']);
	const [img, st, del] = s3.calls;
	assert.equal(img.input.Key, 'now/sub-20260902T091000Z.jpg');
	assert.equal(img.input.ContentType, 'image/jpeg');
	assert.equal(img.input.CacheControl, 'public, max-age=31536000, immutable');
	assert.equal(st.input.Key, 'now/status.json');
	assert.equal(st.input.ContentType, 'application/json');
	assert.equal(st.input.CacheControl, 'no-cache');
	assert.equal(JSON.parse(st.input.Body).frame.url, 'https://live.dustin.space/now/sub-20260902T091000Z.jpg');
	assert.equal(del.input.Key, 'now/sub-old.jpg');
	assert.equal(r.url, 'https://live.dustin.space/now/sub-20260902T091000Z.jpg');
	assert.deepEqual(r.deleted, ['now/sub-old.jpg']);
	assert.deepEqual(r.pendingDelete, []);
});

test('publish: status PUT failure aborts BEFORE any delete (reader never sees a dangling pointer)', async () => {
	const s3 = fakeS3(cmd => cmd.constructor.name === 'PutObjectCommand' && cmd.input.Key === 'now/status.json');
	const p = createPublisher({ s3, bucket: 'b', publicBaseUrl: 'https://live.dustin.space' });
	await assert.rejects(p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: 'now/sub-old.jpg', pendingDelete: [] }), /injected/);
	assert.ok(!s3.calls.some(c => c.name === 'DeleteObjectCommand'));
});

test('publish: delete failure is swallowed into pendingDelete (bounded to 20) and retried next time', async () => {
	const s3 = fakeS3(cmd => cmd.constructor.name === 'DeleteObjectCommand');
	const p = createPublisher({ s3, bucket: 'b', publicBaseUrl: 'https://live.dustin.space' });
	const pending = Array.from({ length: 25 }, (_, i) => `now/sub-p${i}.jpg`);
	const r = await p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: 'now/sub-old.jpg', pendingDelete: pending });
	assert.equal(r.deleted.length, 0);
	assert.equal(r.pendingDelete.length, 20);
	assert.ok(r.pendingDelete.includes('now/sub-old.jpg'), 'the newest failure is kept; oldest are dropped');
});

test('publish: dry-run writes files instead of calling S3', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-'));
	const s3 = fakeS3();
	const p = createPublisher({ s3, bucket: 'b', publicBaseUrl: 'https://live.dustin.space', dryRunDir: dir });
	await p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: null, pendingDelete: [] });
	assert.equal(s3.calls.length, 0);
	assert.ok(fs.existsSync(path.join(dir, 'now', 'sub-20260902T091000Z.jpg')));
	assert.ok(fs.existsSync(path.join(dir, 'now', 'status.json')));
});

test('state: load() on a missing file yields defaults; save() round-trips', () => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'state-')), 'state.json');
	const st = createState(file);
	assert.deepEqual(st.load(), { lastFilename: null, lastKey: null, pendingDelete: [] });
	st.save({ lastFilename: 'a.xisf', lastKey: 'now/sub-a.jpg', pendingDelete: ['x'] });
	assert.deepEqual(createState(file).load(), { lastFilename: 'a.xisf', lastKey: 'now/sub-a.jpg', pendingDelete: ['x'] });
});
```

- [ ] **Step 2: Run → FAIL** (modules missing)

- [ ] **Step 3: Implement `now-imaging/lib/state.js`**

```js
/**
 * state.js — the agent's tiny persistent memory (state.json beside config).
 * {lastFilename, lastKey, pendingDelete[]}: which NINA file was last published,
 * which R2 key holds it, and any old keys whose delete failed and must be retried.
 * Survives agent restarts so a restart never re-publishes or orphans a frame.
 */
'use strict';
const fs = require('node:fs');

const DEFAULTS = () => ({ lastFilename: null, lastKey: null, pendingDelete: [] });

/**
 * createState — receives the state file path; returns {load, save}.
 * load(): parsed state merged over defaults; a missing or corrupt file yields
 * defaults (logged by the caller, not here — this module has no logger).
 * save(obj): writes atomically (temp file + rename) so a crash mid-write can't
 * leave a truncated JSON file that would break the next start.
 */
function createState(filePath) {
	function load() {
		try {
			const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
			return Object.assign(DEFAULTS(), {
				lastFilename: parsed.lastFilename ?? null,
				lastKey: parsed.lastKey ?? null,
				pendingDelete: Array.isArray(parsed.pendingDelete) ? parsed.pendingDelete : [],
			});
		} catch {
			return DEFAULTS();
		}
	}
	function save(obj) {
		const tmp = `${filePath}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(obj, null, '\t'));
		fs.renameSync(tmp, filePath);
	}
	return { load, save };
}

module.exports = { createState };
```

- [ ] **Step 4: Implement `now-imaging/lib/publish.js`**

```js
/**
 * publish.js — write the frame + status to R2 (or to a dry-run directory).
 *
 * ORDER IS LOAD-BEARING (spec §5.5): image first, then status, then delete the
 * previous image. A reader that fetches status.json at any instant therefore
 * sees a URL that already exists. Reversing the order would let the homepage
 * 404 on the frame for the seconds between the two PUTs.
 *
 * The JPEG key is VERSIONED by the frame timestamp so Cloudflare may cache it
 * forever (immutable); status.json is what changes, and JSON is not edge-cached
 * by default (verified in Cloudflare's docs 2026-09-01) — no-cache is belt-and-braces.
 */
'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

// pendingDelete is bounded: a persistent delete failure must not grow state.json forever.
const MAX_PENDING_DELETE = 20;

/**
 * keyForFrame — versioned object key from the frame's UTC timestamp.
 * Receives an ISO string; returns 'now/sub-YYYYMMDDTHHMMSSZ.jpg'.
 */
function keyForFrame(updatedAtIso) {
	const compact = new Date(Date.parse(updatedAtIso)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
	return `now/sub-${compact}.jpg`;
}

/**
 * createPublisher — receives an S3Client-compatible object ({send}), the bucket
 * name, the public base URL (custom domain), and an optional dryRunDir.
 * Returns {publish}.
 */
function createPublisher({ s3, bucket, publicBaseUrl, dryRunDir = null }) {
	const base = String(publicBaseUrl).replace(/\/+$/, '');

	/** put — one object write, to disk in dry-run mode. */
	async function put(key, body, contentType, cacheControl) {
		if (dryRunDir) {
			const file = path.join(dryRunDir, key);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, body);
			return;
		}
		await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl }));
	}

	/** del — one delete; returns true on success, false on failure (caller queues a retry). */
	async function del(key) {
		try {
			if (dryRunDir) { fs.rmSync(path.join(dryRunDir, key), { force: true }); return true; }
			await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * publish — receives {jpegBuffer, status (frame.url unset), prevKey|null,
	 * pendingDelete[]}. Fills status.frame.url, runs the ordered sequence, and
	 * returns {key, url, deleted[], pendingDelete[]}. Throws if either PUT fails
	 * (nothing is deleted in that case).
	 */
	async function publish({ jpegBuffer, status, prevKey, pendingDelete }) {
		const key = keyForFrame(status.updatedAt);
		const url = `${base}/${key}`;
		status.frame.url = url;

		await put(key, jpegBuffer, 'image/jpeg', 'public, max-age=31536000, immutable');
		await put('now/status.json', JSON.stringify(status), 'application/json', 'no-cache');

		// Everything that should no longer exist: prior failures first, then the key we just replaced.
		const toDelete = [...(pendingDelete || []), ...(prevKey && prevKey !== key ? [prevKey] : [])];
		const deleted = [];
		const stillPending = [];
		for (const k of toDelete) {                           // bounded: ≤ MAX_PENDING_DELETE + 1
			if (await del(k)) deleted.push(k); else stillPending.push(k);
		}
		return { key, url, deleted, pendingDelete: stillPending.slice(-MAX_PENDING_DELETE) };
	}

	return { publish };
}

module.exports = { createPublisher, keyForFrame, MAX_PENDING_DELETE };
```

- [ ] **Step 5: Run → PASS; red-proof:** swap the two `put` calls, expect the "status PUT failure aborts before delete" test to still pass but the order assertion in the first test to FAIL; restore.

- [ ] **Step 6: Commit**
```bash
git add now-imaging/lib/publish.js now-imaging/lib/state.js tests/now-imaging/publish.test.js
git commit -m "now-imaging: ordered R2 publish (image -> status -> delete) with dry-run and bounded delete retry"
```

---

### Task 6: `lib/log.js`, `lib/backoff.js`, `agent.js` — the loop

**Files:**
- Create: `now-imaging/lib/log.js`, `now-imaging/lib/backoff.js`, `now-imaging/agent.js`, `now-imaging/README.md`, `tests/now-imaging/backoff.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–5 by the names above.
- Produces: `createLogger(path, {maxBytes}) → {info, warn, error}`; `createDebouncer(fn, ms, {setTimeout, clearTimeout}) → trigger()`; `nextBackoffMs(attempt, {baseMs=1000, capMs=60000, random}) → number`; `loadConfig(path) → config` (validated); `runAgent(deps)` (exported for tests; `agent.js` calls it when run directly).

- [ ] **Step 1: Write the failing tests** (`tests/now-imaging/backoff.test.js`)

```js
'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');
const { createDebouncer, nextBackoffMs } = require('../../now-imaging/lib/backoff');
const { createLogger } = require('../../now-imaging/lib/log');

test('nextBackoffMs: doubles from base, jittered ±20%, capped', () => {
	const r = () => 0.5;                                    // jitter midpoint → exact doubling
	assert.equal(nextBackoffMs(0, { random: r }), 1000);
	assert.equal(nextBackoffMs(1, { random: r }), 2000);
	assert.equal(nextBackoffMs(5, { random: r }), 32000);
	assert.equal(nextBackoffMs(20, { random: r }), 60000);
	const lo = nextBackoffMs(2, { random: () => 0 }), hi = nextBackoffMs(2, { random: () => 1 });
	assert.equal(lo, 3200); assert.equal(hi, 4800);
});

test('createDebouncer: a burst of triggers collapses to one call after the window', () => {
	const timers = [];
	const fake = { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (id) => { timers[id - 1].cleared = true; } };
	let calls = 0;
	const trigger = createDebouncer(() => calls++, 2000, fake);
	trigger(); trigger(); trigger();
	assert.equal(timers.length, 3);
	assert.ok(timers[0].cleared && timers[1].cleared && !timers[2].cleared);
	timers[2].fn();
	assert.equal(calls, 1);
});

test('createLogger: appends timestamped lines and rotates once over maxBytes', () => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'log-')), 'a.log');
	const log = createLogger(file, { maxBytes: 200 });
	for (let i = 0; i < 20; i++) log.info(`line ${i} ${'x'.repeat(20)}`);
	assert.ok(fs.existsSync(`${file}.1`), 'rotated file exists');
	assert.ok(fs.statSync(file).size <= 400, 'live file stays small after rotation');
	assert.match(fs.readFileSync(file, 'utf8'), /^\d{4}-\d{2}-\d{2}T[^ ]+ INFO line/m);
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement `lib/backoff.js` and `lib/log.js`**

```js
/**
 * backoff.js — PURE timing helpers used by agent.js. Timers are injectable so
 * the tests never sleep.
 */
'use strict';

/**
 * nextBackoffMs — exponential reconnect delay: base·2^attempt, ±20% jitter,
 * capped. Receives the attempt number (0-based) and options; returns ms.
 * Jitter keeps a fleet of reconnects from synchronizing (one rig here, but the
 * habit is free); the cap keeps "NINA is closed for the day" at one attempt per
 * minute, not one per hour.
 */
function nextBackoffMs(attempt, { baseMs = 1000, capMs = 60000, random = Math.random } = {}) {
	const exp = Math.min(capMs, baseMs * Math.pow(2, Math.min(attempt, 30)));
	const jitter = 0.8 + 0.4 * random();                   // 0.8 … 1.2
	return Math.min(capMs, Math.round(exp * jitter));
}

/**
 * createDebouncer — receives fn, a window in ms, and an optional timer pair;
 * returns trigger(). Repeated triggers inside the window collapse to one fn
 * call after the last trigger. Why: NINA can emit several IMAGE-SAVE events
 * within a second (e.g. a sub plus its preview); one check() covers them all.
 */
function createDebouncer(fn, ms, timers = { setTimeout, clearTimeout }) {
	let handle = null;
	return function trigger() {
		if (handle !== null) timers.clearTimeout(handle);
		handle = timers.setTimeout(() => { handle = null; fn(); }, ms);
	};
}

module.exports = { nextBackoffMs, createDebouncer };
```

```js
/**
 * log.js — append-only text log with one-file rotation.
 * Dustin's observability preference: every publish and every state change is
 * a line an admin can read; the file is bounded (rotate at maxBytes, keep one
 * predecessor) so a year of nights can't fill the MeLe's disk.
 */
'use strict';
const fs = require('node:fs');

/**
 * createLogger — receives the log file path and {maxBytes} (default 5 MB);
 * returns {info, warn, error}, each taking a message string. Lines are
 * `<ISO time> <LEVEL> <message>`. Also mirrors to stdout/stderr so the
 * Scheduled Task's console (if any) and `npm start` show the same stream.
 */
function createLogger(filePath, { maxBytes = 5 * 1024 * 1024 } = {}) {
	function rotateIfNeeded() {
		try {
			if (fs.existsSync(filePath) && fs.statSync(filePath).size >= maxBytes) fs.renameSync(filePath, `${filePath}.1`);
		} catch { /* rotation is best-effort; logging must never throw */ }
	}
	function write(level, msg) {
		const line = `${new Date().toISOString()} ${level} ${msg}\n`;
		rotateIfNeeded();
		try { fs.appendFileSync(filePath, line); } catch { /* disk trouble: still print below */ }
		(level === 'INFO' ? process.stdout : process.stderr).write(line);
	}
	return {
		info:  (m) => write('INFO', m),
		warn:  (m) => write('WARN', m),
		error: (m) => write('ERROR', m),
	};
}

module.exports = { createLogger };
```

- [ ] **Step 4: Run → PASS; red-proof:** remove `timers.clearTimeout(handle)`, expect the debounce test to FAIL, restore.

- [ ] **Step 5: Implement `now-imaging/agent.js`**

```js
#!/usr/bin/env node
/**
 * agent.js — the "Currently imaging" publisher (spec §5).
 *
 * Runs forever on the MeLe as a Scheduled Task. Sleeps until NINA's WebSocket
 * says an image was saved (or a 5-minute heartbeat fires), then: read history →
 * newest LIGHT → if new, fetch its JPEG by index, read the camera's exposure
 * end time, resolve the target name, build + validate status, publish to R2,
 * persist state. Every failure is logged and retried on the next trigger; the
 * process never exits on its own.
 *
 * Flags: --dry-run (write to ./dry-run/ instead of R2), --config <path>,
 * --once (one check() then exit; used by the dry-run verification task).
 */
'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { S3Client } = require('@aws-sdk/client-s3');

const { createNina, jpegDimensions }     = require('./lib/nina');
const { selectLatestLight, countSubsTonight, nextFrameExpectedAt } = require('./lib/select');
const { createResolver }                 = require('./lib/resolve');
const { buildStatus, validateStatus }    = require('./lib/status');
const { createPublisher }                = require('./lib/publish');
const { createState }                    = require('./lib/state');
const { createLogger }                   = require('./lib/log');
const { createDebouncer, nextBackoffMs } = require('./lib/backoff');

// Consecutive check() failures before an extra "failing repeatedly" warning.
const REPEAT_WARN_AFTER = 5;
// Socket events are debounced this long so a burst becomes one check().
const DEBOUNCE_MS = 2000;

/**
 * loadConfig — receives a path; returns the parsed config with defaults applied,
 * or throws a message naming the missing key. Read once at startup.
 */
function loadConfig(configPath) {
	const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
	const cfg = Object.assign({
		ninaBaseUrl: 'http://localhost:1888', r2Bucket: 'dustinspace-live', publicBaseUrl: 'https://live.dustin.space',
		imageScale: 0.4, jpegQuality: 80, heartbeatSeconds: 300, dryRunDir: null,
		logPath: 'now-imaging.log', statePath: 'state.json', resolveCachePath: 'resolve-cache.json',
	}, raw);
	const dir = path.dirname(configPath);
	for (const k of ['logPath', 'statePath', 'resolveCachePath']) cfg[k] = path.resolve(dir, cfg[k]);
	if (cfg.dryRunDir) cfg.dryRunDir = path.resolve(dir, cfg.dryRunDir);
	if (!(cfg.imageScale > 0 && cfg.imageScale <= 1)) throw new Error('config.imageScale must be in (0, 1]');
	if (!cfg.dryRunDir) {
		for (const k of ['r2AccountId', 'r2AccessKeyId', 'r2SecretAccessKey']) {
			if (!cfg[k] || cfg[k] === 'REPLACE') throw new Error(`config.${k} is missing (set it, or use dryRunDir/--dry-run)`);
		}
	}
	return cfg;
}

/**
 * runAgent — wires everything and starts the loop. Receives {cfg, once, deps}
 * where deps lets tests inject nina/publisher/state/log; returns a stop().
 */
async function runAgent({ cfg, once = false, deps = {} }) {
	const log = deps.log || createLogger(cfg.logPath);
	const nina = deps.nina || createNina({ baseUrl: cfg.ninaBaseUrl });
	const state = deps.state || createState(cfg.statePath);
	const resolver = deps.resolver || createResolver({
		overrides: JSON.parse(fs.readFileSync(path.join(__dirname, 'overrides.json'), 'utf8')),
		cachePath: cfg.resolveCachePath,
	});
	const publisher = deps.publisher || createPublisher({
		s3: cfg.dryRunDir ? null : new S3Client({
			endpoint: `https://${cfg.r2AccountId}.r2.cloudflarestorage.com`, region: 'auto',
			credentials: { accessKeyId: cfg.r2AccessKeyId, secretAccessKey: cfg.r2SecretAccessKey },
		}),
		bucket: cfg.r2Bucket, publicBaseUrl: cfg.publicBaseUrl, dryRunDir: cfg.dryRunDir,
	});

	let failures = 0;
	let running = false;

	/** check — one pass of the publish decision (spec §5.2). Never throws. */
	async function check() {
		if (running) return;                                 // one in flight at a time
		running = true;
		try {
			const history = await nina.history();
			const pick = selectLatestLight(history);
			const st = state.load();
			if (!pick) { failures = 0; return; }
			if (pick.entry.Filename === st.lastFilename) { failures = 0; return; }

			const jpeg = await nina.imageByIndex(pick.index, cfg.imageScale, cfg.jpegQuality);
			const dims = jpegDimensions(jpeg) || { width: null, height: null };
			let next = null;
			try { next = nextFrameExpectedAt(await nina.cameraInfo(), Date.now()); }
			catch (err) { log.warn(`camera/info unavailable (${err.message}); publishing without nextFrameExpectedAt`); }
			const resolved = await resolver.resolve(pick.entry.TargetName);
			const status = buildStatus({
				entry: pick.entry, subsTonight: countSubsTonight(history, pick.entry), nextFrameExpectedAt: next,
				resolved, frameUrl: 'https://placeholder.invalid/', width: dims.width, height: dims.height,
			});
			const result = await publisher.publish({ jpegBuffer: jpeg, status, prevKey: st.lastKey, pendingDelete: st.pendingDelete });
			const v = validateStatus(status);
			if (!v.ok) throw new Error(`status rejected: ${v.reason}`);   // publish() filled the URL; validate the final doc
			state.save({ lastFilename: pick.entry.Filename, lastKey: result.key, pendingDelete: result.pendingDelete });
			failures = 0;
			log.info(`published ${result.key} target="${pick.entry.TargetName}" -> "${resolved.name} / ${resolved.designation}" filter=${pick.entry.Filter} exp=${pick.entry.ExposureTime}s subsTonight=${status.frame.subsTonight} bytes=${jpeg.length}`);
		} catch (err) {
			failures++;
			log.warn(`check failed: ${err.message}`);
			if (failures >= REPEAT_WARN_AFTER) log.warn(`check failing repeatedly (n=${failures})`);
		} finally {
			running = false;
		}
	}

	if (once) { await check(); return { stop() {} }; }

	// --- socket with reconnect (intentionally infinite: this is a daemon) ---
	const trigger = createDebouncer(check, DEBOUNCE_MS);
	let attempt = 0;
	let socket = null;
	let stopped = false;
	function connect() {
		if (stopped) return;
		socket = nina.openSocket(trigger, (s) => {
			if (s === 'open') { attempt = 0; log.info('socket open, subscribed to IMAGE-SAVE'); }
			if (s === 'closed') {
				const wait = nextBackoffMs(attempt++);
				log.info(`socket closed; reconnecting in ${wait} ms`);
				setTimeout(connect, wait);
			}
		});
	}
	connect();
	// Heartbeat: the safety net for a dropped socket or an unexpected event shape.
	const heartbeat = setInterval(check, cfg.heartbeatSeconds * 1000);
	await check();                                          // catch up after a restart mid-night
	log.info(`agent started (nina=${cfg.ninaBaseUrl}, ${cfg.dryRunDir ? 'DRY-RUN ' + cfg.dryRunDir : 'bucket ' + cfg.r2Bucket})`);

	return { stop() { stopped = true; clearInterval(heartbeat); if (socket) socket.close(); } };
}

// Validation note: publish() sets frame.url, so validateStatus runs AFTER
// publish. A rejected document therefore means an already-uploaded status —
// acceptable because the only reachable rejection is the privacy invariant,
// which buildStatus cannot violate by construction; the check exists to catch a
// future edit. (Reviewers: if you add fields, validate a clone with a dummy
// https URL BEFORE publish as well.)

if (require.main === module) {
	const args = process.argv.slice(2);
	const cfgPath = args.includes('--config') ? args[args.indexOf('--config') + 1] : path.join(__dirname, 'config.json');
	const cfg = loadConfig(cfgPath);
	if (args.includes('--dry-run')) cfg.dryRunDir = cfg.dryRunDir || path.join(__dirname, 'dry-run');
	process.on('unhandledRejection', (err) => { console.error(`${new Date().toISOString()} ERROR unhandled: ${err && err.stack || err}`); });
	runAgent({ cfg, once: args.includes('--once') }).catch((err) => { console.error(`fatal: ${err.stack || err}`); process.exit(1); });
}

module.exports = { loadConfig, runAgent };
```

- [ ] **Step 6: Fix the validation ordering flagged in the note** — do it now, not later: in `check()`, before `publisher.publish`, run `validateStatus(Object.assign({}, status, { frame: Object.assign({}, status.frame, { url: 'https://example.invalid/x.jpg' }) }))` and throw on `!ok`; keep the post-publish validation too. Delete the "Validation note" comment once both checks exist. (This is a Power-of-Ten rule 5 point: check before the side effect.)

- [ ] **Step 7: Write `now-imaging/README.md`** — sections: What it does (3 lines + the flow), Install on the MeLe (the Task 14 steps), Config keys (table, every key), Running (`npm start`, `npm run dry-run`, `--once`, `--config`), Overrides (shape + when), Logs (path, rotation, what a healthy night looks like: one `published` line per sub), Troubleshooting (socket never opens → heartbeat still publishes; `check failing repeatedly` → NINA closed or token wrong; `status rejected` → privacy invariant), Privacy (endpoints used, what is never read).

- [ ] **Step 8: Lint, run the whole agent suite, commit**

Run: `cd now-imaging && npx eslint .` → clean. `bounded-run node --test tests/now-imaging/` → all PASS.
```bash
git add now-imaging/lib/log.js now-imaging/lib/backoff.js now-imaging/agent.js now-imaging/README.md tests/now-imaging/backoff.test.js
git commit -m "now-imaging: agent loop (socket + heartbeat + debounce + backoff), logger, README"
```

---

### Task 7: Dry-run against the live rig from Fedora

**Files:** none new (creates `now-imaging/dry-run/` locally, gitignored).

- [ ] **Step 1: Create a dev config** at `now-imaging/config.json` with `"ninaBaseUrl": "http://100.106.198.18:1888"`, `"dryRunDir": "dry-run"`, R2 keys left as `REPLACE` (dry-run doesn't need them).

- [ ] **Step 2: One-shot run:** `node now-imaging/agent.js --once --dry-run`
Expected today (history holds only SNAPSHOT frames): log line `agent`… no `published` line, no error. That is the correct no-op.

- [ ] **Step 3: Force a decode path exercise** without a LIGHT frame: temporarily run `node now-imaging/tools/nina-probe.js http://100.106.198.18:1888` (Task 4) and confirm bytes + dims print. Record the prepared-image dimensions at scale 0.4 in the plan's Status block.

- [ ] **Step 4: Socket soak (5 minutes):** `node now-imaging/agent.js --dry-run` in the background (`run_in_background`), wait ≥ 5 min, then read `now-imaging/now-imaging.log`. Expected: `socket open, subscribed to IMAGE-SAVE`, one heartbeat check per 5 min with no warnings. Stop the process.

- [ ] **Step 5: Record** results in the Status block (socket opened? heartbeat clean?) and note in §9 of the spec that LIGHT selection + IMAGE-SAVE payload remain unverified until the first real night. Commit the doc change.

---

## Phase 2 — the site

### Task 8: `now-imaging-logic.js` — pure liveness, schedule, caption (node-tested)

**Files:**
- Create: `src/assets/js/now-imaging-logic.js`, `tests/now-imaging/logic.test.js`

**Interfaces:**
- Produces (attached to `window.NowImagingLogic` in the browser, `module.exports` under Node — same dual pattern as `gallery-filter-logic.js`): `isLive(status, nowMs) → boolean`; `nextFetchDelayMs(status, nowMs, {minMs=60000, idleMs=300000}) → number`; `caption(status) → string`; `relativeAge(updatedAtIso, nowMs, rtf) → string`; `ordinal(n) → string`; `filterLabel(raw) → string`.

Rules (spec §6.2): live if `age < max(20 min, 3 × exposureSeconds)`; next fetch at `nextFrameExpectedAt + 20 s` if in the future, else if live `updatedAt + exposure + 30 s` floored at 60 s from now, else 5 min.

- [ ] **Step 1: Write the failing tests** (`tests/now-imaging/logic.test.js`)

```js
'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const L = require('../../src/assets/js/now-imaging-logic');

const T0 = Date.parse('2026-09-02T09:10:00Z');
const status = (over) => Object.assign({
	schemaVersion: 1, updatedAt: '2026-09-02T09:10:00.000Z',
	target: { raw: 'Veil Nebula', name: 'Veil Nebula', designation: 'NGC 6960' },
	frame: { url: 'https://live.dustin.space/now/x.jpg', width: 1256, height: 842, filter: 'Ha', exposureSeconds: 300, subsTonight: 23, hfr: 2.1, stars: 412 },
	equipment: { camera: 'QHY268M', telescope: 'Orion Eon 70', focalLengthMm: 350 },
}, over);

test('isLive: under max(20 min, 3×exposure) is live; 20-minute subs get a 60-minute window', () => {
	assert.equal(L.isLive(status(), T0 + 19 * 60000), true);
	assert.equal(L.isLive(status(), T0 + 21 * 60000), false);
	const long = status({ frame: Object.assign(status().frame, { exposureSeconds: 1200 }) });
	assert.equal(L.isLive(long, T0 + 55 * 60000), true);
	assert.equal(L.isLive(long, T0 + 61 * 60000), false);
	assert.equal(L.isLive(status({ updatedAt: 'garbage' }), T0), false);
});

test('nextFetchDelayMs: nextFrameExpectedAt wins when in the future (+20 s), never under the floor', () => {
	const s = status({ nextFrameExpectedAt: '2026-09-02T09:15:15.000Z' });
	assert.equal(L.nextFetchDelayMs(s, T0), 5 * 60000 + 15000 + 20000);
	assert.equal(L.nextFetchDelayMs(s, Date.parse('2026-09-02T09:15:10Z')), 60000, 'floor');
});

test('nextFetchDelayMs: live without nextFrameExpectedAt → updatedAt + exposure + 30 s; idle → 5 min', () => {
	assert.equal(L.nextFetchDelayMs(status(), T0 + 60000), 300000 + 30000 - 60000);
	assert.equal(L.nextFetchDelayMs(status(), T0 + 40 * 60000), 300000);
	// stale nextFrameExpectedAt (in the past) is ignored
	assert.equal(L.nextFetchDelayMs(status({ nextFrameExpectedAt: '2026-09-02T09:00:00Z' }), T0 + 40 * 60000), 300000);
});

test('caption: "Hα · 300 s · 23rd sub tonight"; filter names get their proper symbols', () => {
	assert.equal(L.caption(status()), 'Hα · 300 s · 23rd sub tonight');
	assert.equal(L.filterLabel('OIII'), 'OIII'); assert.equal(L.filterLabel('SII'), 'SII');
	assert.equal(L.filterLabel('Ha'), 'Hα'); assert.equal(L.filterLabel('H-alpha'), 'Hα'); assert.equal(L.filterLabel('L'), 'Luminance');
	assert.equal(L.ordinal(1), '1st'); assert.equal(L.ordinal(2), '2nd'); assert.equal(L.ordinal(3), '3rd');
	assert.equal(L.ordinal(11), '11th'); assert.equal(L.ordinal(12), '12th'); assert.equal(L.ordinal(23), '23rd'); assert.equal(L.ordinal(112), '112th');
	assert.equal(L.caption(status({ frame: Object.assign(status().frame, { exposureSeconds: 0.5, subsTonight: 1 }) })), 'Hα · 0.5 s · 1st sub tonight');
});

test('relativeAge: uses Intl.RelativeTimeFormat with the largest sensible unit', () => {
	const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
	assert.equal(L.relativeAge('2026-09-02T09:10:00Z', T0 + 6 * 3600000, rtf), '6 hours ago');
	assert.equal(L.relativeAge('2026-09-02T09:10:00Z', T0 + 3 * 86400000, rtf), '3 days ago');
	assert.equal(L.relativeAge('2026-09-02T09:10:00Z', T0 + 40 * 60000, rtf), '40 minutes ago');
});
```

- [ ] **Step 2: Run → FAIL** (module missing)

- [ ] **Step 3: Implement `src/assets/js/now-imaging-logic.js`**

```js
/**
 * now-imaging-logic.js — PURE logic for the homepage "Currently imaging" card.
 *
 * No DOM, no fetch, no timers: only functions of (status, now). That is what
 * lets tests/now-imaging/logic.test.js pin the liveness window and the fetch
 * schedule under `node --test`, while the browser loads this file as a classic
 * script and reads window.NowImagingLogic (same dual-environment pattern as
 * gallery-filter-logic.js).
 */
(function (root, factory) {
	// UMD-lite: CommonJS under Node (tests), a global in the browser.
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.NowImagingLogic = factory();
}(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	var MIN_LIVE_MS   = 20 * 60000;   // spec §6.2: never shorter than 20 minutes
	var LIVE_EXPOSURES = 3;           // …or three exposures, whichever is longer
	var FRAME_SLACK_MS = 20000;       // after nextFrameExpectedAt (download + publish)
	var POST_EXPOSURE_MS = 30000;     // fallback estimate slack

	/** exposureMs — the frame's exposure in ms, or 0 when missing/invalid. */
	function exposureMs(status) {
		var s = status && status.frame && Number(status.frame.exposureSeconds);
		return isFinite(s) && s > 0 ? s * 1000 : 0;
	}

	/**
	 * isLive — is the newest frame recent enough to say "Currently imaging"?
	 * Receives the status document and now (ms). Returns boolean; an
	 * unparseable updatedAt is never live.
	 * Why max(20 min, 3 exposures): a dither, autofocus run, or meridian flip
	 * can sit between two subs; 20 min covers those for short subs, and three
	 * exposures covers them for 20-minute narrowband subs (Dustin's amendment).
	 */
	function isLive(status, nowMs) {
		var t = Date.parse(status && status.updatedAt);
		if (!isFinite(t)) return false;
		var window = Math.max(MIN_LIVE_MS, LIVE_EXPOSURES * exposureMs(status));
		return nowMs - t < window;
	}

	/**
	 * nextFetchDelayMs — when to fetch status.json again.
	 * Receives status, now (ms), and {minMs, idleMs}. Returns ms from now.
	 * 1. nextFrameExpectedAt in the future → that moment + slack (agent knows
	 *    the camera's actual end time);
	 * 2. else live → updatedAt + exposure + slack (estimate from the last frame);
	 * 3. else idle → idleMs.
	 * Everything is floored at minMs so a clock skew can't turn into a tight loop.
	 */
	function nextFetchDelayMs(status, nowMs, opts) {
		var minMs  = (opts && opts.minMs)  || 60000;
		var idleMs = (opts && opts.idleMs) || 300000;
		var next = Date.parse(status && status.nextFrameExpectedAt);
		if (isFinite(next) && next > nowMs) return Math.max(minMs, next + FRAME_SLACK_MS - nowMs);
		if (isLive(status, nowMs)) {
			var t = Date.parse(status.updatedAt);
			return Math.max(minMs, t + exposureMs(status) + POST_EXPOSURE_MS - nowMs);
		}
		return idleMs;
	}

	/** ordinal — 1 → "1st", 23 → "23rd", 112 → "112th". */
	function ordinal(n) {
		var v = n % 100;
		if (v >= 11 && v <= 13) return n + 'th';
		var d = n % 10;
		return n + (d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th');
	}

	/**
	 * filterLabel — NINA filter names as astronomers write them.
	 * "Ha"/"H-alpha"/"HA" → "Hα"; "L" → "Luminance"; everything else verbatim
	 * (OIII, SII, R, G, B keep their conventional forms).
	 */
	function filterLabel(raw) {
		var s = String(raw || '').trim();
		if (/^h-?a(lpha)?$/i.test(s)) return 'Hα';
		if (/^l(um(inance)?)?$/i.test(s)) return 'Luminance';
		return s;
	}

	/** caption — "Hα · 300 s · 23rd sub tonight". Exposure printed without trailing zeros. */
	function caption(status) {
		var f = status.frame || {};
		var exp = Number(f.exposureSeconds);
		var expText = isFinite(exp) ? String(+exp.toFixed(2)) + ' s' : '';
		var n = Number(f.subsTonight) || 0;
		var parts = [filterLabel(f.filter), expText, n > 0 ? ordinal(n) + ' sub tonight' : ''];
		return parts.filter(Boolean).join(' · ');
	}

	/**
	 * relativeAge — "6 hours ago" style text for the idle label.
	 * Receives an ISO time, now (ms), and an Intl.RelativeTimeFormat instance
	 * (passed in so the caller decides the locale). Picks the largest unit whose
	 * magnitude is ≥ 1 (minutes → hours → days).
	 */
	function relativeAge(updatedAtIso, nowMs, rtf) {
		var diffMin = Math.round((Date.parse(updatedAtIso) - nowMs) / 60000);   // negative = past
		var abs = Math.abs(diffMin);
		if (abs < 60) return rtf.format(diffMin, 'minute');
		if (abs < 60 * 24) return rtf.format(Math.round(diffMin / 60), 'hour');
		return rtf.format(Math.round(diffMin / (60 * 24)), 'day');
	}

	return { isLive: isLive, nextFetchDelayMs: nextFetchDelayMs, caption: caption, relativeAge: relativeAge, ordinal: ordinal, filterLabel: filterLabel };
}));
```

- [ ] **Step 4: Run → PASS; red-proof:** change `Math.max(MIN_LIVE_MS, …)` to `MIN_LIVE_MS`, expect the 20-minute-sub test to FAIL, restore.

- [ ] **Step 5: Commit**
```bash
git add src/assets/js/now-imaging-logic.js tests/now-imaging/logic.test.js
git commit -m "now-imaging: pure liveness/schedule/caption logic for the homepage card"
```

---

### Task 9: Homepage markup, explainer content, CSS

**Files:**
- Modify: `src/index.njk` (front matter + new section after the `.nav-slot-border` div, before `<!-- ===== RECENT WORK ===== -->`)
- Modify: `src/assets/css/main.css` (append a `NOW IMAGING` block after the `.home-intro` rules, before `FOOTER`)
- Modify: `tests/build-smoke.test.js`

- [ ] **Step 1: Add to `src/index.njk` front matter** the line `homePage: true` (used by Task 10's script gate).

- [ ] **Step 2: Insert the section** into `src/index.njk` immediately after `<div class="nav-slot-border" aria-hidden="true"></div>`:

```njk
{#
	CURRENTLY IMAGING — live card fed by now-imaging.js (spec:
	docs/superpowers/specs/2026-09-01-currently-imaging-design.md).
	The section ships HIDDEN and stays hidden unless the script fetches a
	valid status.json from live.dustin.space. Without JS, or if the rig has
	never published, this markup renders nothing — by design there is never
	an "unavailable" card on the homepage (spec §6.2).
	Data attributes carry no content; every visible string comes from JS.
#}
<section class="now-imaging" id="now-imaging" hidden aria-labelledby="now-imaging-label">
	<div class="container">
		<div class="now-status">
			<span class="now-dot" aria-hidden="true"></span>
			<span class="now-label" id="now-imaging-label">Currently imaging</span>
		</div>
		<div class="now-card">
			{# aspect-ratio is set inline by JS from status.frame.width/height before
			   the image loads, so the card reserves its box and nothing shifts. #}
			<div class="now-frame" id="now-frame">
				<img id="now-image" alt="" decoding="async" loading="lazy" width="3" height="2" />
				<span class="now-frame-tag" id="now-frame-tag"></span>
			</div>
			<div class="now-meta">
				<h2 class="now-name" id="now-name"></h2>
				<p class="now-designation" id="now-designation"></p>
				<p class="now-caption" id="now-caption"></p>
				<button type="button" class="now-whats" id="now-whats" aria-haspopup="dialog" aria-controls="now-dialog">What's this?</button>
			</div>
		</div>
	</div>

	{#
		EXPLAINER — native <dialog>: showModal() gives focus trapping, Escape to
		close, and an ::backdrop for free, with no library. Content voice per
		project CLAUDE.md: astronomer + layperson at once. Historical claims are
		sourced in docs/superpowers/plans/2026-09-01-currently-imaging.md
		(Task 9, "Sources"); keep copy and sources in sync when editing.
	#}
	<dialog class="now-dialog" id="now-dialog" aria-labelledby="now-dialog-title">
		<div class="now-dialog-body">
			<button type="button" class="now-dialog-close" id="now-dialog-close" aria-label="Close">×</button>
			<h2 id="now-dialog-title">What you're looking at</h2>

			<h3>Why this frame looks rough</h3>
			<p>This is one exposure, a few minutes long, straight off the camera: grainy, grey, and faint. It has had nothing done to it except a quick stretch so you can see it at all. Every finished image in the gallery is dozens of frames like this one, sometimes hundreds, combined.</p>

			<h3>Stacking: from glass plates to pixel rejection</h3>
			<p>The word is literal. A century ago astronomers photographed on glass plates, and to see fainter things they would sandwich several plates of the same patch of sky, carefully aligned, and print through the stack. Each plate added a little more signal from the object and a little less of the random grain. The technique survived into the film era and kept its name.</p>
			<p>Today the stack is arithmetic. Software aligns every frame star-to-star, then for each pixel looks at the whole column of values across all the frames and takes a robust average. Anything that appears in only one frame, a satellite trail, a cosmic-ray hit, a hot pixel, is thrown out before averaging: that step is called pixel rejection. The faint glow of a nebula shows up in every frame, so it survives; the grain, which is random, averages away. Noise falls with the square root of the frame count, so forty frames are about twice as clean as ten. That is why a night's work is many short exposures rather than one long one.</p>

			<h3>Why black-and-white?</h3>
			<p>Because the camera is black-and-white on purpose. A colour camera has a fixed mosaic of tiny red, green and blue filters over its pixels, so each pixel only ever sees one colour and three quarters of the light in any given band is thrown away. A monochrome camera sees every photon at every pixel, at full resolution. Colour is added afterwards by shooting through filters one at a time: red, green and blue for stars and galaxies, or the narrow bands that nebulae actually glow in, hydrogen, oxygen and sulphur. Each single frame is one of those bands. What you see above is one wavelength of light from one object, and the colour image is built from stacks of frames like it.</p>
		</div>
	</dialog>
</section>
```

- [ ] **Step 3: Sources for the historical claims (fact-check rule, spec §6.5)** — verify each before the copy ships; record the result here:
- Plate superposition to reach fainter limits: the "composite" / "superposition" technique (multiple plates printed in register) is documented in classic astrophotography practice; e.g., E.E. Barnard's composite printing and the technique used at Yerkes/Lick for faint nebulae. *Verify with a WebFetch of a citable source (e.g., a NASA ADS abstract or a historical astrophotography reference) and paste the URL + one-line quote here before Task 9 commits.* If no clean source is found, soften "A century ago astronomers … sandwich several plates" to "Astronomers working on glass plates would combine several plates of the same field", which needs no date claim.
- Noise ∝ 1/√N for averaging independent frames: standard statistics; no citation needed on the page.
- Bayer mosaic discarding ~¾ of the light per band: standard sensor fact (each pixel has one of R/G/B; green is half the pixels, red and blue a quarter each). Phrase kept as "three quarters of the light in any given band" for red/blue; acceptable simplification, note it here.

- [ ] **Step 4: CSS** — append to `src/assets/css/main.css` before the `FOOTER` banner:

```css
/* ============================================================
   NOW IMAGING — live homepage card (spec 2026-09-01)
   Sits between the hero and Latest Captures. Hidden until JS
   confirms a status document exists; see index.njk comments.
   ============================================================ */
.now-imaging {
	padding: var(--space-16) 0 var(--space-8);
}

.now-status {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	margin-bottom: var(--space-6);
	font-family: var(--font-heading);
	font-size: 0.8125rem;
	font-weight: 600;
	letter-spacing: 0.12em;
	text-transform: uppercase;
	color: var(--text-secondary);
}

/* Live indicator. Green is SEMANTIC (state), deliberately not the teal accent,
   so "live" reads as a state and not as a link. */
.now-dot {
	width: 9px;
	height: 9px;
	border-radius: 50%;
	background: #34d399;
	box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.55);
}
.now-imaging.is-live .now-dot {
	animation: now-pulse 2.4s ease-out infinite;
}
.now-imaging.is-idle .now-dot {
	background: var(--text-muted);
	box-shadow: none;
}
@keyframes now-pulse {
	0%   { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.55); }
	70%  { box-shadow: 0 0 0 10px rgba(52, 211, 153, 0); }
	100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0); }
}
@media (prefers-reduced-motion: reduce) {
	.now-imaging.is-live .now-dot { animation: none; }
}

.now-card {
	display: grid;
	grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
	gap: var(--space-8);
	align-items: center;
}
@media (max-width: 640px) {
	.now-card { grid-template-columns: 1fr; gap: var(--space-5); }
}

.now-frame {
	position: relative;
	aspect-ratio: 3 / 2;           /* overridden inline from the published dimensions */
	background: var(--bg-surface);
	border: 1px solid var(--border-muted);
	border-radius: var(--radius-md);
	overflow: hidden;
}
.now-frame img {
	display: block;
	width: 100%;
	height: 100%;
	object-fit: contain;
	background: #000;
}
.now-frame-tag {
	position: absolute;
	left: var(--space-3);
	bottom: var(--space-3);
	font-family: var(--font-body);
	font-size: 0.6875rem;
	letter-spacing: 0.06em;
	color: var(--text-secondary);
	background: rgba(var(--bg-base-rgb), 0.7);
	padding: 5px 7px;
	border-radius: var(--radius-sm);
}

.now-meta { display: grid; gap: var(--space-2); }
.now-name {
	font-size: clamp(1.5rem, 3vw, 2rem);
	line-height: 1.15;
	margin: 0;
}
.now-designation {
	margin: 0;
	color: var(--accent);
	font-weight: 500;
	letter-spacing: 0.02em;
}
.now-designation:empty { display: none; }
.now-caption {
	margin: 0;
	color: var(--text-secondary);
	font-size: 0.9375rem;
	font-variant-numeric: tabular-nums;
}
.now-whats {
	justify-self: start;
	background: none;
	border: 0;
	padding: 0;
	margin-top: var(--space-2);
	color: var(--accent);
	font: inherit;
	font-size: 0.9375rem;
	text-decoration: underline;
	text-underline-offset: 3px;
	cursor: pointer;
}
.now-whats:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

/* Explainer dialog */
.now-dialog {
	background: var(--bg-elevated);
	color: var(--text-primary);
	border: 1px solid var(--border-muted);
	border-radius: var(--radius-lg);
	padding: 0;
	width: min(64ch, calc(100vw - 2 * var(--space-6)));
	max-height: min(85vh, 900px);
}
.now-dialog::backdrop { background: rgba(var(--bg-base-rgb), 0.7); }
.now-dialog-body {
	position: relative;
	padding: var(--space-8);
	overflow-y: auto;
	max-height: inherit;
}
.now-dialog h2 { margin: 0 0 var(--space-4); }
.now-dialog h3 { margin: var(--space-6) 0 var(--space-2); font-size: 1.0625rem; }
.now-dialog p  { margin: 0 0 var(--space-3); color: var(--text-secondary); line-height: 1.7; }
.now-dialog-close {
	position: absolute;
	top: var(--space-4);
	right: var(--space-4);
	width: 36px;
	height: 36px;
	border-radius: 50%;
	border: 1px solid var(--border-muted);
	background: var(--bg-surface);
	color: var(--text-primary);
	font-size: 1.25rem;
	line-height: 1;
	cursor: pointer;
}
.now-dialog-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

- [ ] **Step 5: Build-smoke assertions** — in `tests/build-smoke.test.js`, after assertion 4 add:

```js
		// 5. Currently-imaging section ships on the homepage, HIDDEN, with its
		//    dialog — and does NOT appear on the projects page (spec §6.1). The
		//    `hidden` attribute is the no-JS/no-status contract: if a future edit
		//    drops it, the empty card would render on every visit.
		assert.match(indexHtml, /<section class="now-imaging" id="now-imaging" hidden/,
			'index.html is missing the hidden now-imaging section');
		assert.ok(indexHtml.includes('<dialog class="now-dialog" id="now-dialog"'),
			'index.html is missing the What\'s-this dialog');
		assert.ok(!projectsHtml.includes('id="now-imaging"'),
			'projects page unexpectedly carries the now-imaging section');
```

- [ ] **Step 6: Run the build smoke** — `bounded-run npm test` (full suite; the smoke builds the site). Expected: all PASS. Red-proof: remove `hidden` from the section, expect assertion 5 to FAIL, restore.

- [ ] **Step 7: Visual check** — `npm start` in the background, then a Playwright screenshot of `/` with the section temporarily un-hidden via `document.getElementById('now-imaging').hidden=false` and sample text injected, at 1280 and 390 px widths. One look, one pass of CSS fixes. (Frontend-design mode: check the rhythm against Latest Captures, the name size, the dot.)

- [ ] **Step 8: Commit**
```bash
git add src/index.njk src/assets/css/main.css tests/build-smoke.test.js
git commit -m "Currently Imaging: homepage section markup, explainer dialog copy, styles"
```

---

### Task 10: `now-imaging.js` — DOM wiring, fetch schedule, dialog

**Files:**
- Create: `src/assets/js/now-imaging.js`
- Modify: `src/_data/assetHash.js` (two keys), `src/_includes/layouts/base.njk` (gated includes after the `galleryPage` block), `tests/build-smoke.test.js` (script-gate assertion)

**Interfaces:**
- Consumes: `window.NowImagingLogic` (Task 8). Fetches `https://live.dustin.space/now/status.json`.

- [ ] **Step 1: `assetHash.js`** — add after `galleryFilterLogicJs`:
```js
	// Currently-imaging card (spec 2026-09-01): pure logic + DOM wiring, both
	// gated on `homePage` front matter, both under the immutable /assets/js/* rule.
	nowImagingLogicJs: hashOf('assets/js/now-imaging-logic.js'),
	nowImagingJs: hashOf('assets/js/now-imaging.js'),
```

- [ ] **Step 2: `base.njk`** — after the `{% endif %}` that closes the `galleryPage` block:
```njk
	<!--
		Currently-imaging card (home page only, `homePage: true` in index.njk).
		now-imaging-logic.js attaches window.NowImagingLogic and MUST run before
		now-imaging.js — both `defer`, listed in order. Both content-hashed.
	-->
	{% if homePage %}
	<script defer src="/assets/js/now-imaging-logic.js?v={{ assetHash.nowImagingLogicJs }}"></script>
	<script defer src="/assets/js/now-imaging.js?v={{ assetHash.nowImagingJs }}"></script>
	{% endif %}
```

- [ ] **Step 3: Build-smoke assertion** (append to assertion 5 block):
```js
		assert.ok(/src="[^"]*now-imaging-logic\.js\?v=[0-9a-f]{8}"/.test(indexHtml) && /src="[^"]*now-imaging\.js\?v=[0-9a-f]{8}"/.test(indexHtml),
			'index.html must include both now-imaging scripts with content hashes');
		assert.ok(!/src="[^"]*now-imaging\.js/.test(projectsHtml),
			'projects page unexpectedly includes now-imaging.js — the homePage gate regressed');
```
Run the smoke → FAIL (scripts not yet included → actually they are, from Step 2; the assertion passes once Step 4's file exists so the hash isn't `missing`). Confirm the `?v=missing` case fails the regex — that is the red state.

- [ ] **Step 4: Implement `src/assets/js/now-imaging.js`**

```js
/**
 * now-imaging.js — DOM wiring for the homepage "Currently imaging" card.
 *
 * Fetches the status document the MeLe agent publishes, renders the card,
 * decides live vs idle, and schedules the next fetch from the agent's
 * nextFrameExpectedAt (all decisions live in now-imaging-logic.js — this file
 * only touches the DOM). No status → the section stays hidden. Ever.
 *
 * Spec: docs/superpowers/specs/2026-09-01-currently-imaging-design.md §6.2
 */
(function () {
	'use strict';

	var STATUS_URL = 'https://live.dustin.space/now/status.json';
	var FETCH_TIMEOUT_MS = 8000;
	// Refetch on tab return only if the last fetch is older than this.
	var STALE_ON_RETURN_MS = 60000;

	var L = window.NowImagingLogic;
	var section = document.getElementById('now-imaging');
	if (!L || !section) return;                            // wrong page or logic file missing: do nothing

	var el = {
		label: document.getElementById('now-imaging-label'),
		frame: document.getElementById('now-frame'),
		img: document.getElementById('now-image'),
		tag: document.getElementById('now-frame-tag'),
		name: document.getElementById('now-name'),
		designation: document.getElementById('now-designation'),
		caption: document.getElementById('now-caption'),
		whats: document.getElementById('now-whats'),
		dialog: document.getElementById('now-dialog'),
		close: document.getElementById('now-dialog-close'),
	};
	var rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || 'en', { numeric: 'auto' });
	var timer = null;
	var lastFetchAt = 0;
	var lastUrl = null;

	/**
	 * render — paint one status document. Receives status and now (ms).
	 * Only swaps the image src when the frame URL changed, so the periodic
	 * refetch never re-downloads or flickers an unchanged frame.
	 */
	function render(status, nowMs) {
		var live = L.isLive(status, nowMs);
		section.classList.toggle('is-live', live);
		section.classList.toggle('is-idle', !live);
		el.label.textContent = live ? 'Currently imaging' : 'Last imaged · ' + L.relativeAge(status.updatedAt, nowMs, rtf);

		var f = status.frame || {};
		if (f.width > 0 && f.height > 0) el.frame.style.aspectRatio = f.width + ' / ' + f.height;
		if (f.url && f.url !== lastUrl) {
			el.img.alt = 'Latest single exposure of ' + status.target.name + ', unprocessed';
			el.img.src = f.url;
			lastUrl = f.url;
		}
		el.tag.textContent = 'SINGLE ' + String(+Number(f.exposureSeconds).toFixed(2)) + ' s EXPOSURE · UNPROCESSED';
		el.name.textContent = status.target.name;
		el.designation.textContent = status.target.designation || '';
		el.caption.textContent = L.caption(status);
		section.hidden = false;
	}

	/** schedule — one pending timer at a time; delay from the logic module. */
	function schedule(status, nowMs) {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(refresh, L.nextFetchDelayMs(status, nowMs));
	}

	/**
	 * refresh — fetch + render + reschedule. Any failure leaves the current
	 * card as-is (or hidden if nothing has rendered yet) and retries on the
	 * idle cadence. `cache: 'no-store'` bypasses the browser cache; the edge
	 * doesn't cache JSON by default (spec §3).
	 */
	function refresh() {
		if (document.visibilityState !== 'visible') return;   // resume on visibilitychange
		var ctrl = new AbortController();
		var kill = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
		lastFetchAt = Date.now();
		fetch(STATUS_URL, { cache: 'no-store', signal: ctrl.signal })
			.then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
			.then(function (status) {
				if (!status || status.schemaVersion !== 1 || !status.target || !status.frame) throw new Error('bad status shape');
				var now = Date.now();
				render(status, now);
				schedule(status, now);
			})
			.catch(function (err) {
				// Quiet by design: a missing status is the normal state before the
				// first night. One console line for anyone debugging; no UI.
				if (window.console && console.info) console.info('[now-imaging] no status:', err.message);
				if (timer !== null) clearTimeout(timer);
				timer = setTimeout(refresh, 5 * 60000);
			})
			.finally(function () { clearTimeout(kill); });
	}

	// Pause while hidden, refresh promptly on return if stale.
	document.addEventListener('visibilitychange', function () {
		if (document.visibilityState === 'visible' && Date.now() - lastFetchAt > STALE_ON_RETURN_MS) refresh();
	});

	// Dialog wiring. showModal() traps focus and handles Escape; backdrop click
	// closes because the dialog element itself receives the click while its
	// inner .now-dialog-body does not.
	el.whats.addEventListener('click', function () { el.dialog.showModal(); });
	el.close.addEventListener('click', function () { el.dialog.close(); });
	el.dialog.addEventListener('click', function (ev) { if (ev.target === el.dialog) el.dialog.close(); });
	el.dialog.addEventListener('close', function () { el.whats.focus(); });

	refresh();
})();
```

- [ ] **Step 5: Run `bounded-run npm test`** → PASS. Red-proof for the gate: remove `homePage: true` from index.njk, expect the script assertion to FAIL, restore.

- [ ] **Step 6: Commit**
```bash
git add src/assets/js/now-imaging.js src/_data/assetHash.js src/_includes/layouts/base.njk tests/build-smoke.test.js
git commit -m "Currently Imaging: homepage script (fetch schedule, render, dialog) gated on homePage"
```

---

### Task 11: CSP hosts in `_headers`

**Files:**
- Modify: `src/_headers` (CSP line + HSTS comment), `tests/headers.test.js`

- [ ] **Step 1: Failing test** — append to `tests/headers.test.js`:
```js
test('_headers: CSP allows live.dustin.space for images and fetches, nowhere else', () => {
	const text = fs.readFileSync(HEADERS_PATH, 'utf8');
	const csp = /^\s*Content-Security-Policy:(.*)$/m.exec(text)[1];
	const directive = (name) => new RegExp(`${name} ([^;]*)`).exec(csp)[1];
	assert.match(directive('img-src'), /https:\/\/live\.dustin\.space/);
	assert.match(directive('connect-src'), /https:\/\/live\.dustin\.space/);
	assert.doesNotMatch(directive('script-src'), /live\.dustin\.space/, 'the live bucket must never be a script source');
});
```
Run → FAIL.

- [ ] **Step 2: Edit `src/_headers`:** add `https://live.dustin.space` to the `img-src` list (after `https://tiles.dustin.space`) and to `connect-src` (same position). In the HSTS comment block add one line: `2026-09-01: live.dustin.space (R2 custom domain, HTTPS) joined the subdomain inventory — includeSubDomains still safe.`

- [ ] **Step 3: Run → PASS. Commit:**
```bash
git add src/_headers tests/headers.test.js
git commit -m "CSP: allow live.dustin.space for the currently-imaging card"
```

---

### Task 12: On-demand Playwright probe with a fixture status server

**Files:**
- Create: `tests/probes/now-imaging.spec.js`, `tests/probes/fixtures/now-status-live.json`, `tests/probes/fixtures/now-status-idle.json`, `tests/probes/now-status-server.js`
- Modify: `tests/playwright-probes.md` (how to run)

Why a local server: the page fetches an absolute `https://live.dustin.space/...` URL. The probe uses Playwright's `page.route()` to intercept that URL and answer from the fixture, so no bucket is needed and both states are testable on demand.

- [ ] **Step 1: Fixtures** — `now-status-live.json` = the §7 example with `updatedAt` rewritten at test time to "now − 2 min" (the spec file does that in `beforeEach`); `now-status-idle.json` = same with `updatedAt` = "now − 6 h" and no `nextFrameExpectedAt`. Frame URL points at `https://live.dustin.space/now/sub-test.jpg`, which the route answers with `tests/now-imaging/fixtures/frame.jpg` (create from the saved bias probe: `cp /tmp/claude/nina-prepared.jpg` if still present, else any 3:2 JPEG; commit ≤ 60 KB).

- [ ] **Step 2: Probe** (`tests/probes/now-imaging.spec.js`), tagged `@ci`:
```js
'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8080';
const FIX = path.join(__dirname, 'fixtures');

function statusFixture(kind) {
	const s = JSON.parse(fs.readFileSync(path.join(FIX, `now-status-${kind}.json`), 'utf8'));
	const ago = kind === 'live' ? 2 * 60000 : 6 * 3600000;
	s.updatedAt = new Date(Date.now() - ago).toISOString();
	if (kind === 'live') s.nextFrameExpectedAt = new Date(Date.now() + 4 * 60000).toISOString();
	return s;
}

async function routeStatus(page, kind) {
	await page.route('https://live.dustin.space/now/status.json', route => kind === 'none'
		? route.fulfill({ status: 404, body: 'not found' })
		: route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(statusFixture(kind)) }));
	await page.route('https://live.dustin.space/now/**.jpg', route =>
		route.fulfill({ status: 200, contentType: 'image/jpeg', body: fs.readFileSync(path.join(__dirname, '..', 'now-imaging', 'fixtures', 'frame.jpg')) }));
}

test('@ci hidden when no status is published', async ({ page }) => {
	await routeStatus(page, 'none');
	await page.goto(BASE_URL + '/');
	await page.waitForTimeout(1500);
	await expect(page.locator('#now-imaging')).toBeHidden();
});

test('@ci live: renders name, designation, caption, pulsing state; no layout shift on image load', async ({ page }) => {
	await routeStatus(page, 'live');
	await page.goto(BASE_URL + '/');
	const section = page.locator('#now-imaging');
	await expect(section).toBeVisible();
	await expect(section).toHaveClass(/is-live/);
	await expect(page.locator('#now-imaging-label')).toHaveText('Currently imaging');
	await expect(page.locator('#now-name')).toHaveText('Veil Nebula');
	await expect(page.locator('#now-designation')).toHaveText('NGC 6960');
	await expect(page.locator('#now-caption')).toHaveText('Hα · 300 s · 23rd sub tonight');
	const before = await page.locator('#now-frame').boundingBox();
	await page.locator('#now-image').evaluate(img => img.complete || new Promise(r => { img.onload = r; }));
	const after = await page.locator('#now-frame').boundingBox();
	expect(Math.abs(before.height - after.height)).toBeLessThan(1);
});

test('@ci idle: "Last imaged · 6 hours ago", static dot', async ({ page }) => {
	await routeStatus(page, 'idle');
	await page.goto(BASE_URL + '/');
	await expect(page.locator('#now-imaging')).toHaveClass(/is-idle/);
	await expect(page.locator('#now-imaging-label')).toHaveText(/Last imaged · 6 hours ago/);
});

test('@ci dialog opens on click, closes on Escape, returns focus', async ({ page }) => {
	await routeStatus(page, 'live');
	await page.goto(BASE_URL + '/');
	await page.locator('#now-whats').click();
	await expect(page.locator('#now-dialog')).toBeVisible();
	await expect(page.locator('#now-dialog-title')).toHaveText('What you\'re looking at');
	await page.keyboard.press('Escape');
	await expect(page.locator('#now-dialog')).toBeHidden();
	await expect(page.locator('#now-whats')).toBeFocused();
});
```

- [ ] **Step 3: Run** (dev server up in the background): `npx playwright test --config tests/probes/playwright.config.js --grep now-imaging` → 4 pass. Note the run in `tests/playwright-probes.md`.

- [ ] **Step 4: Commit**
```bash
git add tests/probes/now-imaging.spec.js tests/probes/fixtures/ tests/now-imaging/fixtures/frame.jpg tests/playwright-probes.md
git commit -m "Currently Imaging: on-demand Playwright probe (hidden / live / idle / dialog)"
```

---

## Phase 3 — infrastructure and the MeLe (Dustin-gated)

### Task 13: R2 bucket, custom domain, scoped token

**Files:** none in the repo. Records go in the plan's Status block.

**Gate:** Dustin either does these in the Cloudflare dashboard or says "do it via the API", in which case use `mcp__cloudflare-api__*` for steps 1–2 and STOP before step 3 (token secrets must be created and copied by him; never echo a token into chat or a file in the repo).

- [ ] **Step 1: Bucket** — R2 → Create bucket → name `dustinspace-live`, location hint same as `dustinspace` (Western North America). No public dev URL needed (leave r2.dev disabled).
- [ ] **Step 2: Custom domain** — bucket Settings → Custom Domains → `live.dustin.space`. Cloudflare adds the DNS record in the zone automatically; wait for "Active". Verify from Fedora: `curl -sI https://live.dustin.space/now/status.json` → HTTP 404 with Cloudflare headers (404 is correct: nothing published yet).
- [ ] **Step 3: Token** — R2 → Manage R2 API Tokens → Create API token: name `now-imaging (MeLe)`, permission **Object Read & Write**, "Apply to specific buckets only" → `dustinspace-live`, TTL forever. Dustin copies Access Key ID + Secret Access Key + the account ID into his password manager. They go ONLY into `now-imaging/config.json` on the MeLe (Task 14) — not into this repo, not into chat.
- [ ] **Step 4: Verify the token's scope** — from Fedora with a throwaway `config.json` in a scratch dir (not the repo), run `node now-imaging/agent.js --config <scratch>/config.json --once` with `ninaBaseUrl` pointed at the tailnet and NO dryRunDir: expected `check` no-op (no LIGHT frame) — proves config loads. Then a one-line S3 `ListObjectsV2` against the `dustinspace` (tiles) bucket with the new token via a small script must FAIL with AccessDenied: that is the blast-radius proof. Delete the scratch config afterwards.
- [ ] **Step 5: Record** bucket name, domain status, token name (not value) in the Status block.

---

### Task 14: Install on the MeLe

**Files:**
- Create: `now-imaging/install-task.ps1`

**Gate:** Dustin's explicit go for (a) installing Node LTS on the observatory PC, (b) registering a Scheduled Task. Both are system changes on a remote production rig. Everything below runs over `ssh mele` (his admin account). NINA is idle in daytime; do this in daytime Arizona.

- [ ] **Step 1: Install Node LTS** — `ssh mele "winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements"`, then in a NEW ssh session `ssh mele "node --version"` → v22.x. If winget is unavailable, download the MSI from nodejs.org and run it with `/quiet` (say so to Dustin first).
- [ ] **Step 2: Copy the package** — from Fedora: `git archive` the `now-imaging/` tree (no config, no dry-run, no node_modules) to a tarball, `scp` to `mele:C:\Users\<user>\now-imaging.tar`, extract with `tar -xf` (Windows 11 ships tar), then `ssh mele "cd C:\Users\<user>\now-imaging && npm ci --omit=dev"`.
- [ ] **Step 3: Config** — Dustin creates `C:\Users\<user>\now-imaging\config.json` from `config.example.json` with the Task 13 token, `ninaBaseUrl` = `http://localhost:1888`, `dryRunDir` = null. Then: `ssh mele "icacls C:\Users\<user>\now-imaging\config.json /inheritance:r /grant:r <user>:F"` so only his account reads it. Verify with `icacls` output.
- [ ] **Step 4: Smoke** — `ssh mele "cd C:\Users\<user>\now-imaging && node agent.js --once"` → log shows config loaded, a no-op check (or a `published` line if a light frame exists in history). Then `curl -s https://live.dustin.space/now/status.json` from Fedora.
- [ ] **Step 5: `install-task.ps1`** (committed; Dustin can read it):
```powershell
# install-task.ps1 — register the "dustin.space now-imaging" Scheduled Task.
# Run once, as the user NINA runs under, from the now-imaging folder:
#   powershell -ExecutionPolicy Bypass -File .\install-task.ps1
#
# What it does, in plain terms:
#   * trigger: at system startup (and immediately, via /run below)
#   * action:  node agent.js in this folder
#   * runs whether the user is logged on or not (NINA starts at logon, the
#     agent's first checks just no-op until NINA answers)
#   * restarts itself every minute if it exits, forever — the agent never exits
#     on purpose, so an exit means a crash worth retrying
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node).Source
$action   = New-ScheduledTaskAction -Execute $node -Argument "agent.js" -WorkingDirectory $here
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
	-ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
Register-ScheduledTask -TaskName "dustin.space now-imaging" -Action $action -Trigger $trigger `
	-Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName "dustin.space now-imaging"
Write-Host "Registered and started. Check: schtasks /query /tn `"dustin.space now-imaging`" /v"
```
Note for the executor: `-LogonType S4U` runs without storing the password and without an interactive session; if NINA's API is only reachable for interactive sessions (it is not — it is a TCP listener), this would matter. Verified acceptable: the API answered over the tailnet with nobody logged in on 2026-09-01.
- [ ] **Step 6: Register** — `ssh mele "powershell -ExecutionPolicy Bypass -File C:\Users\<user>\now-imaging\install-task.ps1"`, then `ssh mele "schtasks /query /tn \"dustin.space now-imaging\""` → Running. Read the log: `ssh mele "type C:\Users\<user>\now-imaging\now-imaging.log"` → `agent started` + `socket open`.
- [ ] **Step 7: Commit** `now-imaging/install-task.ps1`; update the Status block (installed date, task name).

---

## Phase 4 — first night, then QA

### Task 15: First imaging night watch + ELEVATED QA

- [ ] **Step 1: First light frame** — on the next night NINA saves a LIGHT frame: read the MeLe log for the first `published` line; `curl https://live.dustin.space/now/status.json`; open dustin.space and confirm the card. Check the JPEG's byte size and dims; if > ~400 KB or < 1000 px wide, adjust `imageScale`/`jpegQuality` in the MeLe config (no code change) and note the final values in the Status block.
- [ ] **Step 2: Confirm the socket path** — the log should show `published` lines within ~2–5 s of each frame (socket), not only at 5-minute heartbeats. If only heartbeats publish, the IMAGE-SAVE payload differs from TnS's shape: capture one raw socket message (add a temporary `log.info` of the first 200 chars in `openSocket`'s message handler, redeploy), fix the match, remove the temporary log, redeploy. Record what the payload actually was in spec §3.
- [ ] **Step 3: Name check** — verify `target.name`/`designation` for the night's real target; seed `overrides.json` if Simbad's pick is wrong; commit.
- [ ] **Step 4: QA (ELEVATED tier, per spec §10)** — run the three-phase review with `code-reviewer`, `test-analyzer`, `security-auditor` (networked/deployed code + credentials at rest on a remote host). Post to the Dev Sessions Discussion category; run `qa-manifest-check.py`; append the receipt line; memory reconciliation (spec, plan Status, `dustin-space-currently-imaging-plan` entity → status IMPLEMENTED/LIVE, `dustin-space-continuity-thread`).
- [ ] **Step 5: Merge** — work happens on branch `preview/currently-imaging`; after QA, Dustin's "merge it" merges to `main` (Cloudflare Pages deploys). The agent on the MeLe is already live and harmless before the site ships (it only writes to the new bucket).

---

## Sources for the explainer copy (Task 9 fact-check)

Fill during Task 9 Step 3; the copy may not commit with an empty row.

| Claim | Source (URL + one-line quote) | Verified date |
|---|---|---|
| Plates of the same field superposed/printed in register to reach fainter limits | _pending_ | |
| Noise ∝ 1/√N for averaged independent frames | textbook statistics; no page citation | 2026-09-01 |
| Bayer mosaic: one colour per pixel; mono sees every photon per pixel | standard sensor design (Bayer, US patent 3,971,065) | 2026-09-01 |

## Self-review (run after writing; results)

- **Spec coverage:** §1 goal → Tasks 9–10; §2 non-goals → nothing builds them (WebSocket IS built per the amendment; the spec's §2 bullet about WebSocket was superseded by the amendment recorded in §5.2 — executor: the spec's §2 list is pre-amendment for that one item); §3 facts → Tasks 4, 7; §5.1 files → Task 1/6 (plus `tools/`, `backoff.js` added for testability); §5.2 loop → Task 6; §5.3 → Task 6 comment; §5.4 → Task 3; §5.5 → Task 5; §5.6 → Task 14; §6.1 → Task 9; §6.2 → Tasks 8, 10; §6.3 → Task 9; §6.4 → Task 11; §6.5 → Task 9; §7 → Task 2; §8 → Task 13; §9 → Tasks 1–12 tests + 7 + 12 + 15; §10 → Task 15 QA tier; §11 → Tasks 13–14; §12 → Task 8 caption.
- **Placeholder scan:** the only intentional open cell is the Sources table's first row, gated by "may not commit with an empty row".
- **Type consistency:** `selectLatestLight → {entry,index}` used identically in Tasks 4, 6, 7; `buildStatus` args match Task 6's call; `publisher.publish` returns `{key,url,deleted,pendingDelete}` consumed in Task 6; `NowImagingLogic` names match between Tasks 8 and 10; `createNina` option names (`fetchImpl`, `WebSocketImpl`) match tests.
- **Known deviation from spec §5.1:** added `lib/backoff.js` and `tools/` (probe scripts). Reason: the debounce/backoff policy needed a pure home to be testable; the probes are the dry-run instruments. Recorded here per the deviation-summary rule.
