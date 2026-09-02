/**
 * tests/now-imaging/agent-check.test.js — pins for agent.js's check(), the one
 * decision in this package that nothing else in the suite executes. The other
 * agent tests cover the pieces around it (config parsing, the reconnect policy,
 * the debouncer); this file runs the whole pass: history → newest LIGHT → fetch
 * → resolve → build → validate → publish → save state → log.
 *
 * Every pin drives the REAL runAgent with `once: true`, which performs exactly
 * one check() and starts neither the socket nor the heartbeat — so no test here
 * leaves a timer behind or waits a real millisecond.
 *
 * nina / resolver / publisher / log are injected through `deps`. `state`
 * deliberately is NOT: a real createState on a temp file is what gives the
 * dedupe pin its meaning, since the second run has to read back what the first
 * one wrote, through JSON, exactly as the agent does on the rig.
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const { runAgent }                      = require('../../now-imaging/agent');
const { keyForFrame }                   = require('../../now-imaging/lib/publish');
const { validateStatus, FORBIDDEN_KEY }  = require('../../now-imaging/lib/status');
const { TINY_JPEG_B64 }                 = require('./fixtures/tiny-jpeg');

// The public origin every expectation below is built from. Matches the default
// in loadConfig so the keys and URLs read like the real ones.
const PUBLIC_BASE = 'https://live.dustin.space';

/**
 * light — a LIGHT history row shaped like NINA's, same fields select.test.js
 * uses. Receives an overrides object merged over the defaults; returns the row.
 */
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

/**
 * tmpState — a fresh state.json path in its own temp directory.
 * Receives nothing; returns the absolute path (the file does not exist yet,
 * which is the first-run case createState is built for).
 */
function tmpState() {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-check-')), 'state.json');
}

/**
 * cfgFor — the minimum config runAgent reads on the `once` path.
 * Receives the state file path; returns the config object. heartbeatSeconds,
 * logPath and resolveCachePath are absent on purpose: the heartbeat is never
 * started here, and the logger, resolver and publisher are all injected, so a
 * value for any of them would only look load-bearing.
 */
function cfgFor(statePath) {
	return { statePath, imageScale: 0.2, jpegQuality: 80, publicBaseUrl: PUBLIC_BASE };
}

/**
 * fakeNina — the four NINA surfaces, none of them networked.
 * Receives the history array to serve; returns the client object. The image is
 * the real 1x1 JPEG from the fixture module, so jpegDimensions decodes actual
 * bytes rather than being handed a shape that only looks like a JPEG.
 */
function fakeNina(history) {
	return {
		history: async () => history,
		imageByIndex: async () => Buffer.from(TINY_JPEG_B64, 'base64'),
		// Idle camera: nextFrameExpectedAt() returns null, so the published
		// document omits that field. The exposing case is pinned in select.test.js.
		cameraInfo: async () => ({ IsExposing: false, ExposureEndTime: null }),
	};
}

// A resolver that answers without Simbad or a cache file. Fixed answer: these
// tests are about check()'s sequence, and resolve.js has its own pins.
const fakeResolver = { resolve: async () => ({ name: 'Veil Nebula', designation: 'NGC 6960' }) };

/**
 * fakeLog — collects lines instead of writing them. Receives nothing; returns
 * {lines, info, warn, error}, where lines holds `LEVEL message` strings in
 * order. The log IS the agent's output on a rig nobody watches, so the lines
 * are assertions here, not decoration.
 */
function fakeLog() {
	const lines = [];
	return {
		lines,
		info:  (m) => lines.push(`INFO ${m}`),
		warn:  (m) => lines.push(`WARN ${m}`),
		error: (m) => lines.push(`ERROR ${m}`),
	};
}

/**
 * recordingPublisher — a stand-in for lib/publish.js that records the call.
 * Receives the array to push each call onto; returns the publisher object.
 *
 * The key and URL are derived with the REAL keyForFrame against the same base
 * the agent uses, because check() re-derives the URL itself and throws
 * "published URL mismatch" if the two disagree. A publisher that invented its
 * own key would trip that tripwire and this file would be pinning the tripwire
 * instead of the publish path.
 *
 * The recorded status is a deep copy taken BEFORE the frame.url assignment the
 * real publish() performs, so an assertion about "what check() handed over"
 * cannot be answered with something the publisher wrote afterwards.
 */
function recordingPublisher(calls) {
	return {
		async publish({ jpegBuffer, status, prevKey, pendingDelete }) {
			const key = keyForFrame(status.updatedAt);
			calls.push({
				status: JSON.parse(JSON.stringify(status)),
				bytes: jpegBuffer.length, prevKey, pendingDelete, key,
			});
			status.frame.url = `${PUBLIC_BASE}/${key}`;
			return { key, url: `${PUBLIC_BASE}/${key}`, deleted: [], pendingDelete: [], deleteErrors: [] };
		},
	};
}

/**
 * readState — parse the state file. Receives its path; returns the parsed
 * object. Read raw rather than through createState so a missing field shows up
 * as missing instead of being filled in by that module's defaults.
 */
function readState(statePath) {
	return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

test('check: a new LIGHT frame publishes, saves state, and logs one line', async () => {
	const statePath = tmpState();
	const entry = light({});
	const calls = [];
	const log = fakeLog();

	await runAgent({
		cfg: cfgFor(statePath), once: true,
		deps: { log, nina: fakeNina([entry]), resolver: fakeResolver, publisher: recordingPublisher(calls) },
	});

	assert.equal(calls.length, 1, 'exactly one publish for one new frame');

	// (a) State names the frame that was published and the key it went to.
	const saved = readState(statePath);
	assert.equal(saved.lastFilename, entry.Filename);
	assert.equal(saved.lastKey, keyForFrame(entry.Date));
	assert.deepEqual(saved.pendingDelete, []);

	// (b) One INFO line, carrying the key and the target name an operator greps for.
	const published = log.lines.filter((l) => l.startsWith('INFO published'));
	assert.equal(published.length, 1, `one published line — got ${JSON.stringify(log.lines)}`);
	assert.match(published[0], /target="Veil Nebula"/);
	assert.match(published[0], /dims=1x1/);   // the real fixture bytes were decoded

	// (e) The document handed to the publisher is the one the gate would accept,
	// and carries no coordinate-shaped key. The key walk is independent of
	// validateStatus's own: JSON.stringify's replacer visits every key at every
	// depth, so this fails even if findForbiddenKey's traversal were wrong.
	const sent = calls[0].status;
	assert.deepEqual(validateStatus(sent), { ok: true });
	const keys = [];
	JSON.stringify(sent, (k, v) => { keys.push(k); return v; });
	assert.ok(!keys.some((k) => FORBIDDEN_KEY.test(k)), `no forbidden key — saw ${JSON.stringify(keys)}`);
	assert.equal(sent.frame.exposureSeconds, 300);
	assert.equal(sent.target.designation, 'NGC 6960');
});

test('check: a second pass over the same history publishes nothing', async () => {
	const statePath = tmpState();
	const history = [light({})];
	const calls = [];

	await runAgent({
		cfg: cfgFor(statePath), once: true,
		deps: { log: fakeLog(), nina: fakeNina(history), resolver: fakeResolver, publisher: recordingPublisher(calls) },
	});
	assert.equal(calls.length, 1, 'the first pass published');

	// Second run, same state file: the dedupe has to survive the JSON round-trip.
	const log = fakeLog();
	await runAgent({
		cfg: cfgFor(statePath), once: true,
		deps: { log, nina: fakeNina(history), resolver: fakeResolver, publisher: recordingPublisher(calls) },
	});
	assert.equal(calls.length, 1, 'the second pass published nothing');
	// And it said so: a silent pass is indistinguishable from a dead heartbeat.
	assert.ok(log.lines.includes('INFO check: no new light frame (history=1, trigger=once)'),
		`the quiet pass logs its trigger — got ${JSON.stringify(log.lines)}`);
});

test('check: an empty history logs the same quiet line and touches no state', async () => {
	const statePath = tmpState();
	const calls = [];
	const log = fakeLog();

	await runAgent({
		cfg: cfgFor(statePath), once: true,
		deps: { log, nina: fakeNina([]), resolver: fakeResolver, publisher: recordingPublisher(calls) },
	});

	assert.equal(calls.length, 0);
	assert.equal(fs.existsSync(statePath), false, 'nothing published means nothing written');
	assert.ok(log.lines.includes('INFO check: no new light frame (history=0, trigger=once)'),
		`got ${JSON.stringify(log.lines)}`);
});

test('check: a status-upload failure queues the orphan and leaves lastFilename alone', async () => {
	const statePath = tmpState();
	// Seeded as if an earlier frame had published, so "unchanged" is a real value
	// rather than the null a first run would leave either way.
	fs.writeFileSync(statePath, JSON.stringify({
		lastFilename: 'previous.xisf', lastKey: 'now/sub-20260902T000000Z.jpg', pendingDelete: [],
	}));
	const log = fakeLog();
	// The shape lib/publish.js throws when the JPEG PUT succeeded and the
	// status PUT did not: the original error, tagged with the now-unreferenced key.
	const failing = {
		publish: async () => {
			const err = new Error('status PUT failed');
			err.orphanKey = 'now/sub-x.jpg';
			throw err;
		},
	};

	await runAgent({
		cfg: cfgFor(statePath), once: true,
		deps: { log, nina: fakeNina([light({})]), resolver: fakeResolver, publisher: failing },
	});

	const saved = readState(statePath);
	assert.equal(saved.lastFilename, 'previous.xisf', 'the live frame is still the one state names');
	assert.equal(saved.lastKey, 'now/sub-20260902T000000Z.jpg');
	assert.deepEqual(saved.pendingDelete, ['now/sub-x.jpg'], 'the orphan is queued for the next publish');
	assert.ok(log.lines.some((l) => l.startsWith('WARN queued orphaned frame now/sub-x.jpg')),
		`the queueing is logged — got ${JSON.stringify(log.lines)}`);
	assert.ok(log.lines.some((l) => l.startsWith('WARN check failed: status PUT failed')),
		'the original failure is still reported');
});

test('check: a row with no usable Filename dedupes on Date instead', async () => {
	// NINA has always sent a Filename, so this pins the fallback rather than an
	// observed shape: without it the comparison would be `undefined === null`,
	// the frame would publish, and `lastFilename: undefined` would vanish through
	// JSON.stringify — leaving the same frame to publish again on every trigger.
	const statePath = tmpState();
	const entry = light({ Filename: '' });
	const calls = [];

	await runAgent({
		cfg: cfgFor(statePath), once: true,
		deps: { log: fakeLog(), nina: fakeNina([entry]), resolver: fakeResolver, publisher: recordingPublisher(calls) },
	});
	assert.equal(calls.length, 1);
	assert.equal(readState(statePath).lastFilename, entry.Date, 'Date became the dedupe key');

	await runAgent({
		cfg: cfgFor(statePath), once: true,
		deps: { log: fakeLog(), nina: fakeNina([entry]), resolver: fakeResolver, publisher: recordingPublisher(calls) },
	});
	assert.equal(calls.length, 1, 'and it deduped on the second pass');
});
