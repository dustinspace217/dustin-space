/**
 * tests/now-imaging/r2-probe.test.js — pins for tools/r2-probe.js's verdict.
 *
 * The probe exists to catch a mis-created token BEFORE the first imaging
 * night. On 2026-09-02 it passed a token that could only read, and the first
 * night (2026-09-19) failed every publish with Access Denied. These pins drive
 * runProbe with a fake S3 client whose `send` answers per command class, so
 * each permission shape a token can have gets a verdict asserted here.
 *
 * Every term of the verdict (live readable, tiles refused with AccessDenied,
 * put ok, delete ok) has a case in which it is the ONLY thing wrong, so
 * deleting any single term from the `pass` expression turns a test red. The
 * first version of this file lacked that: its fakes could only throw
 * AccessDenied and always allowed the live LIST, so two single-term mutants
 * and the "any error counts as denied" bug were all invisible to it.
 *
 * The SDK is not imported here: the root tests/ tree resolves against the
 * site's node_modules, which has no @aws-sdk, and publish.test.js sets the
 * precedent of dispatching on the command's constructor name instead.
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { runProbe, describeError, TILES_BUCKET, SCRATCH_KEY } = require('../../now-imaging/tools/r2-probe');

const LIVE = 'dustinspace-live';
const KEY = 'now/_probe-test.txt';

/**
 * sdkError — an error shaped like one the SDK throws. Receives the name and
 * optional extra properties (code, message); returns the Error.
 * A service error carries its S3 code in .name ('AccessDenied'); a transport
 * failure is a plain Error (name 'Error') with the reason in .code and
 * .message — the shape measured against a bad endpoint on 2026-09-20.
 */
function sdkError(name, extra) {
	const err = new Error((extra && extra.message) || name);
	err.name = name;
	if (extra && extra.code) err.code = extra.code;
	return err;
}

const DENIED = () => sdkError('AccessDenied', { message: 'Access Denied' });

/**
 * fakeS3 — a client whose send() consults a policy per (command, bucket).
 * Receives {list, put, del}: each a function (bucket) => null to ALLOW, or a
 * value to THROW (an Error from sdkError, or anything else — one case throws
 * undefined on purpose). Returns {send, calls} where calls records every
 * command class + bucket + key in order.
 */
function fakeS3({ list, put, del }) {
	const calls = [];
	/** decide — record the call, then allow or throw per the policy's answer. */
	function decide(record, answer) {
		calls.push(record);
		if (answer !== null) throw answer;
		return {};
	}
	return {
		calls,
		async send(cmd) {
			const { Bucket, Key } = cmd.input;
			const kind = cmd.constructor.name;
			if (kind === 'ListObjectsV2Command') return decide(['list', Bucket], list(Bucket));
			if (kind === 'PutObjectCommand')     return decide(['put', Bucket, Key], put(Bucket));
			if (kind === 'DeleteObjectCommand')  return decide(['del', Bucket, Key], del(Bucket));
			throw new Error(`unexpected command ${kind}`);
		},
	};
}

// The well-behaved token: live bucket allowed, everything else refused.
const liveOnly = (b) => (b === LIVE ? null : DENIED());
const allow = () => null;
const deny = () => DENIED();

/** collect — an `out` sink. Receives nothing; returns {lines, out}. */
function collect() {
	const lines = [];
	return { lines, out: (l) => lines.push(l) };
}

/** run — runProbe against a fake with the test scratch key. Returns {pass, lines, calls}. */
async function run(policy) {
	const s3 = fakeS3(policy);
	const { lines, out } = collect();
	const pass = await runProbe({ s3, liveBucket: LIVE, scratchKey: KEY, out });
	return { pass, lines, calls: s3.calls };
}

test('r2-probe: a read-only token on the right bucket FAILS (the 2026-09-19 first-night shape)', async () => {
	const { pass, lines } = await run({ list: liveOnly, put: deny, del: deny });
	assert.equal(pass, false);
	assert.ok(lines.includes(`write ${KEY}: put DENIED AccessDenied, delete DENIED AccessDenied`), JSON.stringify(lines));
	assert.ok(!lines.some((l) => l.includes('remove it by hand')), 'nothing was written, so nothing is left to remove');
	assert.ok(lines.some((l) => l.startsWith('FAIL')));
});

test('r2-probe: a read+write token scoped to the live bucket PASSES and leaves nothing behind', async () => {
	const { pass, lines, calls } = await run({ list: liveOnly, put: liveOnly, del: liveOnly });
	assert.equal(pass, true);
	assert.ok(lines.includes(`live bucket ${LIVE}: readable (expected)`));
	assert.ok(lines.includes(`tiles bucket ${TILES_BUCKET}: denied AccessDenied (expected)`));
	assert.ok(lines.includes(`write ${KEY}: put ok, delete ok`), JSON.stringify(lines));
	assert.ok(lines.some((l) => l.startsWith('PASS')));
	assert.deepEqual(calls, [['list', LIVE], ['list', TILES_BUCKET], ['put', LIVE, KEY], ['del', LIVE, KEY]],
		'exactly one put and one delete of the scratch key, on the live bucket only');
});

test('r2-probe: an over-scoped token (tiles readable) FAILS even though it can write', async () => {
	const { pass, lines } = await run({ list: allow, put: liveOnly, del: liveOnly });
	assert.equal(pass, false);
	assert.ok(lines.some((l) => l.includes('READABLE (unexpected: token is over-scoped)')));
});

test('r2-probe: put denied but delete allowed FAILS — the put term alone decides it', async () => {
	// The only case where put is the single thing wrong. Without the verdict
	// assertion here, `write.put.ok` could be deleted from `pass` unnoticed.
	const { pass, lines, calls } = await run({ list: liveOnly, put: deny, del: liveOnly });
	assert.equal(pass, false);
	assert.ok(lines.includes(`write ${KEY}: put DENIED AccessDenied, delete ok`), JSON.stringify(lines));
	assert.ok(calls.some((c) => c[0] === 'del'), 'the delete is attempted even when the put was denied');
});

test('r2-probe: put allowed but delete denied FAILS and names the leftover object', async () => {
	const { pass, lines } = await run({ list: liveOnly, put: liveOnly, del: deny });
	assert.equal(pass, false);
	assert.ok(lines.some((l) => l.includes(`the scratch object is still in ${LIVE}`)), JSON.stringify(lines));
});

test('r2-probe: a token that cannot LIST its own bucket FAILS even though it can write', async () => {
	// The only case where the live LIST is the single thing wrong.
	const { pass, lines } = await run({ list: deny, put: liveOnly, del: liveOnly });
	assert.equal(pass, false);
	assert.ok(lines.includes(`live bucket ${LIVE}: DENIED AccessDenied (unexpected)`), JSON.stringify(lines));
});

test('r2-probe: a tiles-bucket error that is NOT AccessDenied is inconclusive and FAILS', async () => {
	// Everything else is perfect in each row; only the tiles LIST outcome varies.
	// "The call threw" is not evidence of isolation: only an explicit
	// AccessDenied is. A timeout that certified an over-scoped token would be
	// the 2026-09-02 false PASS all over again, on the security check.
	const rows = [
		sdkError('TimeoutError', { message: 'socket timed out' }),
		sdkError('InternalError', { message: 'We encountered an internal error' }),
		sdkError('NoSuchBucket', { message: 'The specified bucket does not exist' }),
		sdkError('Error', { code: 'EPROTO', message: 'write EPROTO handshake failure' }),
	];
	for (const tilesError of rows) {
		const { pass, lines } = await run({ list: (b) => (b === LIVE ? null : tilesError), put: liveOnly, del: liveOnly });
		assert.equal(pass, false, `${tilesError.name}/${tilesError.code || '-'} must not certify isolation`);
		assert.ok(lines.some((l) => l.startsWith(`tiles bucket ${TILES_BUCKET}: INCONCLUSIVE, FAILED `)), JSON.stringify(lines));
		assert.ok(!lines.some((l) => l.includes('denied')), 'an inconclusive result is never worded as a denial');
	}
});

test('r2-probe: a transport failure prints its code AND its message, never a bare "Error"', async () => {
	// Measured shape (2026-09-20, bad endpoint): name 'Error', code 'EPROTO'.
	const transport = () => sdkError('Error', { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND bad.r2.cloudflarestorage.com' });
	const { pass, lines } = await run({ list: liveOnly, put: transport, del: liveOnly });
	assert.equal(pass, false);
	assert.ok(lines.includes(`write ${KEY}: put FAILED ENOTFOUND: getaddrinfo ENOTFOUND bad.r2.cloudflarestorage.com, delete ok`),
		JSON.stringify(lines));
});

test('r2-probe: a thrown non-Error is reported as UnknownError instead of crashing the probe', async () => {
	const { pass, lines } = await run({ list: liveOnly, put: () => undefined, del: liveOnly });
	assert.equal(pass, false);
	assert.ok(lines.includes(`write ${KEY}: put FAILED UnknownError, delete ok`), JSON.stringify(lines));
});

test('describeError: name unless it is "Error", then code, then Code, then UnknownError; message kept', () => {
	assert.deepEqual(describeError(sdkError('AccessDenied', { message: 'Access Denied' })), { code: 'AccessDenied', message: 'Access Denied' });
	assert.deepEqual(describeError(sdkError('Error', { code: 'EPROTO', message: 'write EPROTO\n' })), { code: 'EPROTO', message: 'write EPROTO' });
	assert.deepEqual(describeError({ Code: 'SlowDown' }), { code: 'SlowDown', message: '' });
	assert.deepEqual(describeError(new Error('boom')), { code: 'UnknownError', message: 'boom' });
	assert.deepEqual(describeError(null), { code: 'UnknownError', message: '' });
	assert.deepEqual(describeError('a string'), { code: 'UnknownError', message: '' });
});

test('r2-probe: the constants name the real things', () => {
	// TILES_BUCKET is a fact about the outside world; this only guards a typo.
	// R2 answers AccessDenied for a nonexistent bucket too (measured 2026-09-20),
	// so a wrong name here would make check 2 pass while protecting nothing.
	assert.equal(TILES_BUCKET, 'dustinspace');
	assert.equal(SCRATCH_KEY, 'now/_probe.txt');
	assert.doesNotMatch(SCRATCH_KEY, /^now\/sub-.*\.jpg$/, 'never a frame key');
	assert.notEqual(SCRATCH_KEY, 'now/status.json');
});

test('r2-probe: with no scratchKey given, the fixed SCRATCH_KEY is what gets written and removed', async () => {
	const s3 = fakeS3({ list: liveOnly, put: liveOnly, del: liveOnly });
	await runProbe({ s3, liveBucket: LIVE, out: () => {} });
	assert.deepEqual(s3.calls.slice(2), [['put', LIVE, SCRATCH_KEY], ['del', LIVE, SCRATCH_KEY]]);
});
