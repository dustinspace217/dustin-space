/**
 * tests/now-imaging/r2-probe.test.js — pins for tools/r2-probe.js's verdict.
 *
 * The probe exists to catch a mis-created token BEFORE the first imaging
 * night. On 2026-09-02 it passed a token that could only read, and the first
 * night (2026-09-19) failed every publish with Access Denied. These pins drive
 * runProbe with a fake S3 client whose `send` answers per command class, so
 * each permission shape a token can have gets a verdict asserted here:
 * read-only must FAIL, over-scoped must FAIL, read+write must PASS.
 *
 * The SDK is not imported here: the root tests/ tree resolves against the
 * site's node_modules, which has no @aws-sdk, and publish.test.js sets the
 * precedent of dispatching on the command's constructor name instead.
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { runProbe, scratchKeyNow, TILES_BUCKET } = require('../../now-imaging/tools/r2-probe');

const LIVE = 'dustinspace-live';
const KEY = 'now/_probe-test.txt';

/**
 * accessDenied — an error shaped like the SDK's S3 AccessDenied.
 * Receives nothing; returns the Error with .name set.
 */
function accessDenied() {
	const err = new Error('Access Denied');
	err.name = 'AccessDenied';
	return err;
}

/**
 * fakeS3 — a client whose send() consults a policy per (command, bucket).
 * Receives {list, put, del}: each a function (bucket) => true to allow or
 * false to deny; returns {send, calls} where calls records every command
 * class + bucket + key in order.
 */
function fakeS3({ list, put, del }) {
	const calls = [];
	return {
		calls,
		async send(cmd) {
			const { Bucket, Key } = cmd.input;
			const kind = cmd.constructor.name;
			if (kind === 'ListObjectsV2Command') { calls.push(['list', Bucket]); if (!list(Bucket)) throw accessDenied(); return {}; }
			if (kind === 'PutObjectCommand')     { calls.push(['put', Bucket, Key]); if (!put(Bucket)) throw accessDenied(); return {}; }
			if (kind === 'DeleteObjectCommand')  { calls.push(['del', Bucket, Key]); if (!del(Bucket)) throw accessDenied(); return {}; }
			throw new Error(`unexpected command ${kind}`);
		},
	};
}

/** collect — an `out` sink. Receives nothing; returns {lines, out}. */
function collect() {
	const lines = [];
	return { lines, out: (l) => lines.push(l) };
}

test('r2-probe: a read-only token on the right bucket FAILS (the 2026-09-19 first-night shape)', async () => {
	const s3 = fakeS3({ list: (b) => b === LIVE, put: () => false, del: () => false });
	const { lines, out } = collect();
	const pass = await runProbe({ s3, liveBucket: LIVE, scratchKey: KEY, out });
	assert.equal(pass, false);
	assert.ok(lines.some((l) => l.startsWith(`write ${KEY}: put DENIED AccessDenied, delete DENIED AccessDenied`)), JSON.stringify(lines));
	assert.ok(lines.some((l) => l.startsWith('FAIL')));
});

test('r2-probe: a read+write token scoped to the live bucket PASSES and leaves nothing behind', async () => {
	const s3 = fakeS3({ list: (b) => b === LIVE, put: (b) => b === LIVE, del: (b) => b === LIVE });
	const { lines, out } = collect();
	const pass = await runProbe({ s3, liveBucket: LIVE, scratchKey: KEY, out });
	assert.equal(pass, true);
	assert.ok(lines.some((l) => l.startsWith('PASS')));
	assert.deepEqual(s3.calls, [['list', LIVE], ['list', TILES_BUCKET], ['put', LIVE, KEY], ['del', LIVE, KEY]],
		'exactly one put and one delete of the scratch key, on the live bucket only');
});

test('r2-probe: an over-scoped token (tiles readable) FAILS even though it can write', async () => {
	const s3 = fakeS3({ list: () => true, put: (b) => b === LIVE, del: (b) => b === LIVE });
	const { lines, out } = collect();
	const pass = await runProbe({ s3, liveBucket: LIVE, scratchKey: KEY, out });
	assert.equal(pass, false);
	assert.ok(lines.some((l) => l.includes('READABLE (unexpected: token is over-scoped)')));
});

test('r2-probe: put allowed but delete denied FAILS and names the leftover object', async () => {
	const s3 = fakeS3({ list: (b) => b === LIVE, put: (b) => b === LIVE, del: () => false });
	const { lines, out } = collect();
	const pass = await runProbe({ s3, liveBucket: LIVE, scratchKey: KEY, out });
	assert.equal(pass, false);
	assert.ok(lines.some((l) => l.includes(`the scratch object is still in ${LIVE}`)), JSON.stringify(lines));
});

test('r2-probe: the delete is attempted even when the put was denied', async () => {
	const s3 = fakeS3({ list: (b) => b === LIVE, put: () => false, del: () => true });
	await runProbe({ s3, liveBucket: LIVE, scratchKey: KEY, out: () => {} });
	assert.ok(s3.calls.some((c) => c[0] === 'del'), 'a half-written key is never left unnamed');
});

test('r2-probe: the scratch key can never collide with a frame key', () => {
	const key = scratchKeyNow(new Date('2026-09-20T10:05:07.123Z'));
	assert.equal(key, 'now/_probe-20260920T100507Z.txt');
	assert.doesNotMatch(key, /^now\/sub-.*\.jpg$/);
});
