/**
 * tests/osd-loader.test.js — the lazy OpenSeadragon loader (council D5, #125).
 *
 * Executes the production closure functions loadOsd() and openLightbox() from
 * detail.js in a vm sandbox (same extract() pattern as annotation-flash.test.js),
 * because the lines that matter — the SRI `integrity` and `crossOrigin`
 * assignments on the injected <script>, the one-re-entry-per-click bound, and
 * the retry after a failed download — are JavaScript that the build-smoke test
 * cannot execute (QA 2026-09-20). Each test names the mutation it kills so a
 * future mutation-testing survivor list reads correctly.
 *
 * What the sandbox cannot do: build a real viewer. The stand-in OpenSeadragon
 * constructor records what it was given and then throws a SENTINEL, which ends
 * openLightbox at the exact line where the real library would take over.
 *
 * The opt-in last test (CHECK_SRI=1) fetches the pinned CDN file and hashes it
 * against the JSON block, so a well-formed-but-wrong hash cannot ship green
 * (SA-2). It needs the network, so it is never part of the default `npm test`.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../src/assets/js/detail.js'), 'utf8');
const template = fs.readFileSync(path.join(__dirname, '../src/gallery/image.njk'), 'utf8');

/** Read one complete named closure function; fail if its source boundary changes. */
function extract(name) {
	const start = source.indexOf('\t\tfunction ' + name + '(');
	assert.ok(start >= 0, `missing production function: ${name}`);
	const end = source.indexOf('\n\t\t}', start);
	assert.ok(end > start, `missing function boundary: ${name}`);
	return source.slice(start, end + '\n\t\t}'.length);
}

/** The loader config exactly as the template ships it (src + integrity). */
function templateConfig() {
	const block = template.match(/id="osd-loader">\s*(\{[\s\S]*?\})\s*<\/script>/);
	assert.ok(block, 'image.njk has no #osd-loader JSON block');
	return JSON.parse(block[1]);
}

const GOOD = {
	src: 'https://cdn.jsdelivr.net/npm/openseadragon@6.0.2/build/openseadragon/openseadragon.min.js',
	integrity: 'sha384-' + 'A'.repeat(64),
};
const R1 = 'https://tiles.example/v1-r1.dzi';
const R2 = 'https://tiles.example/v1-r2.dzi';

// A re-entry bug in this code is a loop of promise callbacks. Those run before
// Node's timers, so neither settle() nor node:test's `timeout` could ever fire:
// the run would hang instead of failing (ST-6). Every .then() in the sandbox is
// therefore counted, and past this many the harness throws RUNAWAY, which ends
// the loop and lands in `escaped` for the test to assert on. A healthy click
// uses fewer than ten.
const MAX_THEN_CALLS = 200;

/**
 * Build the sandbox.
 *
 * `outcomes` is a queue, one entry per <script> the code appends:
 *   'error'          — the fetch fails (network or SRI mismatch)
 *   'load'           — the script runs and defines OpenSeadragon
 *   'load-no-global' — the load event fires but nothing was defined (a browser
 *                      too old to parse the bundle)
 * An append past the end of the queue fails like 'error'.
 *
 * Returns the context plus everything the fakes recorded.
 */
function harness(cfg, outcomes) {
	const queue = outcomes.slice();
	const appended = [];     // every <script> element handed to head.appendChild
	const errors = [];       // console.error messages
	const constructed = [];  // one entry per OpenSeadragon(...) call
	const escaped = [];      // anything thrown inside a promise callback except the SENTINEL
	let thenCalls = 0;

	const container = {
		children: [],
		appendChild(el) { this.children.push(el); },
		// A browser's `textContent = ''` removes every child. Without this the
		// fake would stack notices a real page never shows (ST-8).
		set textContent(v) { assert.equal(v, ''); this.children.length = 0; },
		get textContent() { return ''; },
		// Only the one selector production uses; anything else is a test bug.
		querySelector(sel) {
			assert.equal(sel, '.osd-error');
			return this.children.find(c => c.className === 'osd-error') || null;
		},
		removeChild(el) { this.children.splice(this.children.indexOf(el), 1); },
	};
	const trigger = {
		attrs: {},
		setAttribute(k, v) { this.attrs[k] = v; },
		removeAttribute(k) { delete this.attrs[k]; },
		getAttribute(k) { return this.attrs[k]; },
	};

	// Stand-in for the library: record the container's state and the options at
	// construction time, then stop openLightbox (the rest needs a real viewer).
	const StandInOsd = function (opts) {
		constructed.push({ opts, childrenAtConstruct: container.children.map(c => c.className) });
		throw new Error('SENTINEL: viewer construction reached');
	};

	// Promise subclass handed to the sandbox as its `Promise`. It counts .then()
	// calls (the runaway bound above) and catches what re-entry callbacks throw:
	// the SENTINEL is expected and dropped, anything else is kept for the test.
	class TestPromise extends Promise {
		then(onOk, onErr) {
			thenCalls += 1;
			if (thenCalls > MAX_THEN_CALLS) throw new Error('RUNAWAY: re-entry loop');
			const guard = fn => (typeof fn !== 'function' ? fn : value => {
				try { return fn(value); } catch (e) {
					if (!/^SENTINEL/.test(e.message)) escaped.push(e.message);
					return undefined;
				}
			});
			return super.then(guard(onOk), guard(onErr));
		}
	}

	const context = {
		console: { error: msg => errors.push(msg), warn: () => {} },
		Promise: TestPromise,
		document: {
			body: { style: {} },
			head: {
				appendChild(el) {
					appended.push(el);
					const outcome = queue.shift() || 'error';
					// Insertion starts the (fake) fetch; settle it asynchronously
					// the way a real browser would, so the promise plumbing runs.
					Promise.resolve().then(() => {
						if (outcome === 'load') { context.OpenSeadragon = StandInOsd; el.onload(); }
						else if (outcome === 'load-no-global') el.onload();
						else el.onerror();
					});
				},
			},
			getElementById(id) {
				// null = no block on the page; a string = the block's raw text
				// (for unparseable JSON); an object = a well-formed block.
				if (id === 'osd-loader') {
					if (cfg === null) return null;
					return { textContent: typeof cfg === 'string' ? cfg : JSON.stringify(cfg) };
				}
				if (id === 'osd-viewer') return container;
				return null;
			},
			createElement(tag) { return { tag, className: '', textContent: '' }; },
		},
		// openLightbox's closure state, at the values a first open sees.
		osdLoadPromise: null,
		// Two revisions, the SECOND one final: a plain click must open R2, and a
		// deep link that names r1 must open R1. If the deferral dropped the
		// revision id, the deep link would silently fall back to R2 (ST-3).
		variantMap: { v1: {
			dziUrl: 'https://tiles.example/v1.dzi',
			revisions: [{ id: 'r1', dzi_url: R1 }, { id: 'r2', dzi_url: R2, is_final: true }],
		} },
		activeVariant: null, lastTrigger: null, activeRevision: null,
		lightbox: { hidden: true },
		annotBtn: null, showingAnnotated: false, showingObjects: false,
		viewer: null,
		renderFilmstrip: () => {}, updateUrlState: () => {},
		notifyVariantUnavailable: () => {},
	};
	vm.createContext(context);
	vm.runInContext(['loadOsd', 'openLightbox'].map(extract).join('\n'), context, { timeout: 1000 });
	return { context, appended, errors, constructed, escaped, container, trigger };
}

/** Let every queued promise callback run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** The notices currently inside the fake viewer container. */
const notices = container => container.children.filter(c => c.className === 'osd-error');

test('loadOsd injects the script with the SRI integrity and crossorigin from the JSON block', async () => {
	// kills: deleting `s.integrity = cfg.integrity` (fails OPEN — unchecked script)
	// kills: deleting `s.crossOrigin = 'anonymous'` (fails CLOSED — SRI on a no-cors fetch)
	// kills: deleting `if (osdLoadPromise) return osdLoadPromise` (two callers, two downloads)
	const { context, appended } = harness(GOOD, ['load']);
	const first = context.loadOsd();
	const second = context.loadOsd();
	assert.equal(first, second, 'callers during one load share one promise');
	await first;
	assert.equal(appended.length, 1, 'exactly one script element appended');
	assert.equal(appended[0].tag, 'script');
	assert.equal(appended[0].src, GOOD.src);
	assert.equal(appended[0].integrity, GOOD.integrity);
	assert.equal(appended[0].crossOrigin, 'anonymous');
});

test('loadOsd does nothing when OpenSeadragon is already defined', async () => {
	// kills: deleting the early `typeof OpenSeadragon !== 'undefined'` return
	const { context, appended } = harness(GOOD, ['load']);
	context.OpenSeadragon = function () {};
	await context.loadOsd();
	assert.equal(appended.length, 0);
});

test("the template's real #osd-loader block is accepted by loadOsd", async () => {
	// The validation regexes live in detail.js and the block lives in image.njk.
	// This is the default-suite test that fails if the two drift apart (ST-9b);
	// build-smoke checks the built page, not what detail.js will accept.
	const cfg = templateConfig();
	const { context, appended, errors } = harness(cfg, ['load']);
	await context.loadOsd();
	assert.equal(errors.length, 0);
	assert.equal(appended.length, 1);
	assert.equal(appended[0].src, cfg.src);
	assert.equal(appended[0].integrity, cfg.integrity);
});

for (const [label, bad] of Object.entries({
	'missing block': null,
	// kills: removing the try/catch around JSON.parse — the throw would escape
	// the click after aria-busy was set, leaving a stuck trigger and no notice
	'block that is not valid JSON': '{ "src": ',
	'non-jsdelivr src': { ...GOOD, src: 'https://evil.example/openseadragon.min.js' },
	'other jsdelivr package': { ...GOOD, src: 'https://cdn.jsdelivr.net/npm/anything@1.0.0/x.js' },
	// URL parsing collapses "../", so these two would fetch /npm/evil@1.0.0/x.js
	// while passing a prefix-only check (SR-5/ST-5, probed with `new URL`).
	'dot-segment traversal': { ...GOOD, src: 'https://cdn.jsdelivr.net/npm/openseadragon@6.0.2/../evil@1.0.0/x.js' },
	'encoded dot-segment traversal': { ...GOOD, src: 'https://cdn.jsdelivr.net/npm/openseadragon@6.0.2/%2e%2e/evil@1.0.0/x.js' },
	// kills: dropping `^` from the src regex
	'good URL embedded after another origin': { ...GOOD, src: 'https://evil.example/?u=' + GOOD.src },
	'malformed integrity': { ...GOOD, integrity: 'sha256-abc' },
})) {
	test(`a ${label} is refused: no script injected, the click lands on the notice`, async () => {
		// kills: deleting the src/integrity validation (SA-1): the fake block
		// would be injected as-is.
		const { context, appended, errors, escaped, container, trigger } = harness(bad, ['load']);
		await assert.rejects(context.loadOsd());
		assert.equal(appended.length, 0, 'nothing appended on a refused config');
		assert.equal(errors.length, 1, 'one developer-facing console.error');
		context.openLightbox('v1', trigger);
		await settle();
		assert.equal(appended.length, 0, 'the click did not inject it either');
		assert.equal(notices(container).length, 1, 'the visitor sees the failure notice');
		assert.equal(trigger.getAttribute('aria-busy'), undefined);
		assert.deepEqual(escaped, []);
	});
}

test('a click loads the script, then opens the viewer at the final revision', async () => {
	// kills: `.then(reopen, reopen)` -> `.then(null, reopen)` (the script loads,
	//        the viewer never opens, aria-busy sticks) — SR-3/ST-1
	const { context, appended, constructed, escaped, trigger } = harness(GOOD, ['load']);
	context.openLightbox('v1', trigger);
	assert.equal(trigger.getAttribute('aria-busy'), 'true', 'busy while the script downloads');
	assert.equal(context.lightbox.hidden, true, 'nothing opens before the library exists');
	await settle();
	assert.deepEqual(escaped, []);
	assert.equal(appended.length, 1);
	assert.equal(trigger.getAttribute('aria-busy'), undefined, 'busy cleared once loaded');
	assert.equal(constructed.length, 1, 'viewer construction reached exactly once');
	assert.equal(constructed[0].opts.tileSources, R2, 'a plain click opens the final revision');
});

test('a ?r= deep link keeps its revision through the deferred open (null trigger)', async () => {
	// kills: dropping `revisionId` from the re-entry call — every deep link
	//        goes through the deferral, because OSD is never loaded at page load
	const { context, constructed, escaped } = harness(GOOD, ['load']);
	context.openLightbox('v1', null, 'r1');
	await settle();
	assert.deepEqual(escaped, []);
	assert.equal(constructed.length, 1);
	assert.equal(constructed[0].opts.tileSources, R1, 'the requested revision, not the final one');
});

test('a failed load shows the notice after ONE fetch; the next click fetches again and opens clean', async () => {
	// kills: `.then(reopen, reopen)` -> `.then(reopen)` (notice never shown, aria-busy stuck)
	// kills: dropping `true` from the re-entry call. Here the automatic refetch
	//        takes the queued 'load' and succeeds, so this test goes red on
	//        "fetched exactly once"; where every attempt fails (the refusal rows
	//        and the two-clicks test) the same mutant loops and trips RUNAWAY.
	// kills: deleting `osdLoadPromise = null` in onerror (second click inherits the
	//        stale rejection and never fetches)
	// kills: deleting the stale-notice removal ahead of `viewer = OpenSeadragon(...)`
	const { context, appended, constructed, escaped, container, trigger } = harness(GOOD, ['error', 'load']);
	context.openLightbox('v1', trigger);
	await settle();
	assert.deepEqual(escaped, []);
	assert.equal(appended.length, 1, 'the failing click fetched exactly once');
	assert.equal(trigger.getAttribute('aria-busy'), undefined, 'busy cleared on failure');
	assert.equal(context.lightbox.hidden, false, 'lightbox opened to show the notice');
	assert.equal(notices(container).length, 1);
	assert.match(container.children[0].textContent, /failed to load/);
	assert.equal(context.osdLoadPromise, null, 'the failed attempt is not kept');
	assert.equal(constructed.length, 0);

	context.openLightbox('v1', trigger);
	await settle();
	assert.deepEqual(escaped, []);
	assert.equal(appended.length, 2, 'second click started a second download');
	assert.equal(constructed.length, 1, 'and reached the viewer');
	assert.deepEqual(constructed[0].childrenAtConstruct, [], 'old notice removed before the viewer was built');
});

test('a script that loads without defining OpenSeadragon is a failed load, not a loop', async () => {
	// kills: deleting the `typeof OpenSeadragon === 'undefined'` check in onload.
	//        The re-entry bound alone still shows the notice, so the assertion
	//        that kills it is the SECOND click fetching again (a resolved promise
	//        left in place would never refetch) plus the console.error.
	const { context, appended, errors, constructed, escaped, container, trigger } =
		harness(GOOD, ['load-no-global', 'load']);
	context.openLightbox('v1', trigger);
	await settle();
	assert.deepEqual(escaped, []);
	assert.equal(appended.length, 1);
	assert.equal(notices(container).length, 1);
	assert.equal(errors.length, 1, 'logged for developers');
	assert.equal(context.osdLoadPromise, null);

	context.openLightbox('v1', trigger);
	await settle();
	assert.equal(appended.length, 2, 'the next click tried again');
	assert.equal(constructed.length, 1);
});

test('a hover warm-up that failed earlier does not decide what the first click shows', async () => {
	// SR-2: the old state flag made the first click after a failed warm-up show
	// the notice without trying. kills: any "failed" latch that outlives the attempt.
	const { context, appended, constructed, escaped, container, trigger } = harness(GOOD, ['error', 'load']);
	await assert.rejects(context.loadOsd());   // what the warm-up listener does
	assert.equal(appended.length, 1);
	context.openLightbox('v1', trigger);
	await settle();
	assert.deepEqual(escaped, []);
	assert.equal(appended.length, 2, 'the click made its own attempt');
	assert.equal(constructed.length, 1);
	assert.equal(notices(container).length, 0, 'no failure notice was ever shown');
});

test('two clicks queued on one failing load: one fetch, one notice, no automatic refetch', async () => {
	// kills: re-entering the load guard when afterLoad is true (SR-4/ST-7): the
	//        second queued re-entry would start a download nobody clicked for
	const { context, appended, escaped, container, trigger } = harness(GOOD, ['error', 'error']);
	context.openLightbox('v1', trigger);
	context.openLightbox('v1', trigger);
	await settle();
	assert.deepEqual(escaped, []);
	assert.equal(appended.length, 1);
	assert.equal(notices(container).length, 1);
	assert.equal(trigger.getAttribute('aria-busy'), undefined);
});

test('detail.js calls loadOsd() from exactly two places: the click guard and the one-shot warm-up', () => {
	// The unit tests above run two extracted functions; nothing executes the
	// event wiring, and build-smoke reads HTML only. Without this, one stray
	// `loadOsd();` at wiring time would download the bundle on every page load —
	// the exact cost D5 removes — with every other test green (SR-8/ST-4).
	// Comment lines are dropped first so prose mentioning the call cannot trip it.
	const code = source.split('\n').filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
	const calls = code.match(/(?<!function )loadOsd\(\)/g) || [];
	assert.equal(calls.length, 2, 'loadOsd() call sites (click guard + warm-up)');
	// `warm` itself: one definition and the two listeners. A bare `warm();` or a
	// window 'load' listener would be a fourth mention (ST confirm pass).
	assert.equal((code.match(/\bwarm\b/g) || []).length, 3, 'mentions of the warm-up function');
	assert.match(code, /var warm = function \(\) \{ loadOsd\(\)\.then\(null, function \(\) \{\}\); \};/);
	assert.match(code, /addEventListener\('pointerenter', warm, \{ once: true \}\)/);
	assert.match(code, /addEventListener\('focus', warm, \{ once: true \}\)/);
});

test('CHECK_SRI=1: the pinned hash matches the bytes the CDN serves', { skip: process.env.CHECK_SRI !== '1' ? 'set CHECK_SRI=1 to fetch the CDN file' : false, timeout: 30000 }, async () => {
	// Opt-in network check (SA-2/TA-6): a well-formed but wrong hash would
	// otherwise ship green and take the viewer down for every visitor.
	const cfg = templateConfig();
	const res = await fetch(cfg.src);
	assert.equal(res.status, 200);
	const digest = crypto.createHash('sha384').update(Buffer.from(await res.arrayBuffer())).digest('base64');
	assert.equal('sha384-' + digest, cfg.integrity, 'JSON block integrity != sha384 of the served file');
});
