'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');
const { createPublisher, keyForFrame, R2_TIMEOUT_MS, DELETE_BUDGET_MS } = require('../../now-imaging/lib/publish');
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
	const r = await p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: 'now/sub-20260901T000000Z.jpg', pendingDelete: [] });
	// Two assertions that prove different things. The names prove the command KINDS
	// (two puts, then a delete). The keys prove the ORDER — both puts share one
	// constructor name, so the name list alone cannot see an image/status swap, which
	// is the exact regression the "order is load-bearing" contract exists to stop.
	assert.deepEqual(s3.calls.map(c => c.name), ['PutObjectCommand', 'PutObjectCommand', 'DeleteObjectCommand']);
	assert.deepEqual(s3.calls.map(c => c.input.Key), ['now/sub-20260902T091000Z.jpg', 'now/status.json', 'now/sub-20260901T000000Z.jpg']);
	const [img, st, del] = s3.calls;
	assert.equal(img.input.Key, 'now/sub-20260902T091000Z.jpg');
	assert.equal(img.input.ContentType, 'image/jpeg');
	// One day, not one year: a DELETE does not evict cached copies, and a frame is
	// only referenced for minutes (security review SA-5).
	assert.equal(img.input.CacheControl, 'public, max-age=86400, immutable');
	assert.equal(st.input.Key, 'now/status.json');
	assert.equal(st.input.ContentType, 'application/json');
	assert.equal(st.input.CacheControl, 'no-cache');
	assert.equal(JSON.parse(st.input.Body).frame.url, 'https://live.dustin.space/now/sub-20260902T091000Z.jpg');
	assert.equal(del.input.Key, 'now/sub-20260901T000000Z.jpg');
	assert.equal(r.url, 'https://live.dustin.space/now/sub-20260902T091000Z.jpg');
	assert.deepEqual(r.deleted, ['now/sub-20260901T000000Z.jpg']);
	assert.deepEqual(r.pendingDelete, []);
	assert.deepEqual(r.deleteErrors, []);
});

test('publish: status PUT failure aborts BEFORE any delete (reader never sees a dangling pointer)', async () => {
	const s3 = fakeS3(cmd => cmd.constructor.name === 'PutObjectCommand' && cmd.input.Key === 'now/status.json');
	const p = createPublisher({ s3, bucket: 'b', publicBaseUrl: 'https://live.dustin.space' });
	await assert.rejects(
		p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: 'now/sub-20260901T000000Z.jpg', pendingDelete: [] }),
		(err) => {
			// The original failure survives — the publisher rethrows it rather than wrapping.
			assert.match(err.message, /injected/);
			// The JPEG PUT already succeeded, so that object is now referenced by nothing.
			// The error must carry its key or the caller cannot clean it up.
			assert.equal(err.orphanKey, 'now/sub-20260902T091000Z.jpg');
			return true;
		},
	);
	assert.ok(!s3.calls.some(c => c.name === 'DeleteObjectCommand'));
});

test('publish: delete failure is swallowed into pendingDelete (bounded to 20) and retried next time', async () => {
	const s3 = fakeS3(cmd => cmd.constructor.name === 'DeleteObjectCommand');
	const p = createPublisher({ s3, bucket: 'b', publicBaseUrl: 'https://live.dustin.space' });
	const pending = Array.from({ length: 25 }, (_, i) => `now/sub-202608${String(i + 1).padStart(2, '0')}T000000Z.jpg`);
	const r = await p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: 'now/sub-20260901T000000Z.jpg', pendingDelete: pending });
	assert.equal(r.deleted.length, 0);
	assert.equal(r.pendingDelete.length, 20);
	assert.ok(r.pendingDelete.includes('now/sub-20260901T000000Z.jpg'), 'the newest failure is kept; oldest are dropped');
	// Every attempted key is reported, not just the 20 that survive the cap: the queue
	// is capped for state.json's sake, but a dropped key is exactly the one the operator
	// most needs to hear about. Count comes from this test's own inputs, not a literal.
	const attempted = pending.length + 1;   // the whole pending queue, plus prevKey
	assert.equal(r.deleteErrors.length, attempted);
	for (const e of r.deleteErrors) {
		assert.equal(typeof e.key, 'string');
		assert.ok(e.message.length > 0, 'every delete error carries a reason to log');
		// The thrown value itself rides along: an R2 refusal's message does not say
		// which refusal, and the agent reads the name and HTTP status off the object.
		assert.ok(e.error instanceof Error && e.error.message === e.message);
	}
	// 26 failures, 20 kept: the six OLDEST are named, because nothing will ever
	// delete them now and someone has to be told which objects those are.
	assert.deepEqual(r.dropped, pending.slice(0, 6));
	assert.deepEqual(r.skipped, [], 'the budget was not the reason');
});

test('publish: a JPEG upload that fails is tagged as a possible orphan too', async () => {
	// A request R2 completed but whose answer never arrived fails HERE and lands
	// THERE; the 30 s deadline makes that more likely. The first version tagged
	// only the status PUT, so this object could stay public with nothing queued.
	const s3 = fakeS3(cmd => cmd.constructor.name === 'PutObjectCommand' && cmd.input.Key !== 'now/status.json');
	const p = createPublisher({ s3, bucket: 'b', publicBaseUrl: 'https://live.dustin.space' });
	await assert.rejects(
		p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: null, pendingDelete: [] }),
		(err) => { assert.equal(err.orphanKey, 'now/sub-20260902T091000Z.jpg'); assert.match(err.message, /injected/); return true; },
	);
	assert.equal(s3.calls.length, 1, 'the status document is never written after a failed image upload');
});

test('publish: a JPEG upload that R2 REFUSED is not tagged, because nothing was stored', async () => {
	// The first night's failure shape: AccessDenied, HTTP 403, on every frame for
	// 21 hours. Tagging those would queue one phantom key per frame and end in
	// ERROR lines about objects that never existed. A 5xx is R2 not knowing
	// either, so that one IS tagged.
	const thrower = (status) => ({ send: async () => { throw Object.assign(new Error('nope'), { name: 'X', $metadata: { httpStatusCode: status } }); } });
	const run = (status) => createPublisher({ s3: thrower(status), bucket: 'b', publicBaseUrl: 'https://live.dustin.space' })
		.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: null, pendingDelete: [] });
	for (const status of [400, 403, 404, 499]) {
		await assert.rejects(run(status), (err) => { assert.equal(err.orphanKey, undefined, `HTTP ${status} is a refusal`); return true; });
	}
	for (const status of [500, 503, 399]) {
		await assert.rejects(run(status), (err) => { assert.equal(err.orphanKey, 'now/sub-20260902T091000Z.jpg', `HTTP ${status} leaves it open`); return true; });
	}
});

test('publish: the delete loop stops starting deletes when its time budget is spent, and keeps the rest in order', async () => {
	// A clock this test owns: each delete "takes" 25 s. Budget 60 s: deletes start
	// at 0, 25 and 50 s; at 75 s the budget is spent and the rest are not attempted.
	let clock = 1000;
	const s3 = { send: async (cmd) => { if (cmd.constructor.name === 'DeleteObjectCommand') clock += 25000; return {}; } };
	const p = createPublisher({ s3, bucket: 'b', publicBaseUrl: 'https://live.dustin.space', deleteBudgetMs: 60000, now: () => clock });
	const pending = Array.from({ length: 5 }, (_, i) => `now/sub-2026080${i + 1}T000000Z.jpg`);
	const r = await p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: null, pendingDelete: pending });
	assert.deepEqual(r.deleted, pending.slice(0, 3));
	assert.deepEqual(r.skipped, pending.slice(3));
	assert.deepEqual(r.pendingDelete, pending.slice(3), 'unattempted keys go back on the queue, oldest first');
	assert.deepEqual(r.deleteErrors, [], 'not attempting is not a failure');
	assert.equal(DELETE_BUDGET_MS, 60000, 'agent.js STUCK_AFTER_MS comment does its sum with this number');
});

test('publish: any key that is not an exact frame key is refused, reported once, and never retried', async () => {
	const s3 = fakeS3();
	const p = createPublisher({ s3, bucket: 'b', publicBaseUrl: 'https://live.dustin.space' });
	const r = await p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: null, pendingDelete: ['../x', 'now/status.json', 'now/..', 'now/.', 'now/sub-old.jpg', 'now/sub-20260831T000000Z.jpg'] });
	assert.deepEqual(r.deleted, ['now/sub-20260831T000000Z.jpg']);
	// Refused before the client is touched: only the well-formed key produced a command.
	assert.deepEqual(s3.calls.filter(c => c.name === 'DeleteObjectCommand').map(c => c.input.Key), ['now/sub-20260831T000000Z.jpg']);
	// Every refused key is reported, including the three the old, looser pattern
	// let through: the status document itself, and the two dot-paths that resolve
	// to a directory in dry-run mode.
	assert.deepEqual(r.deleteErrors.map(e => e.key), ['../x', 'now/status.json', 'now/..', 'now/.', 'now/sub-old.jpg']);
	assert.ok(r.deleteErrors.every(e => e.message === 'invalid key'));
	// Dropped rather than queued — a malformed key would fail identically forever, so
	// retrying it just holds a slot until it ages out of the cap.
	assert.deepEqual(r.pendingDelete, []);
});

test('publish: excludes the current key from both cleanup sources and retries stale delete failures', async () => {
	let failDelete = true;
	const s3 = fakeS3(cmd => cmd.constructor.name === 'DeleteObjectCommand' && failDelete);
	const p = createPublisher({ s3, bucket: 'b', publicBaseUrl: 'https://live.dustin.space' });
	const key = keyForFrame(baseStatus().updatedAt);
	const stale = 'now/sub-20260830T000000Z.jpg';
	const first = await p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: key, pendingDelete: [key, stale, key] });
	assert.deepEqual(s3.calls.filter(c => c.name === 'DeleteObjectCommand').map(c => c.input.Key), [stale]);
	assert.deepEqual(first.pendingDelete, [stale]);
	assert.deepEqual(first.deleteErrors.map(e => e.key), [stale]);

	failDelete = false;
	const recovered = await p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: key, pendingDelete: first.pendingDelete });
	assert.deepEqual(recovered.deleted, [stale]);
	assert.deepEqual(recovered.pendingDelete, []);
	assert.deepEqual(recovered.deleteErrors, []);
});

test('publish: dry-run writes files instead of calling S3, and deletes the previous frame', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-'));
	const s3 = fakeS3();
	const p = createPublisher({ s3, bucket: 'b', publicBaseUrl: 'https://live.dustin.space', dryRunDir: dir });
	const first = await p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: null, pendingDelete: [] });
	assert.equal(s3.calls.length, 0);
	assert.ok(fs.existsSync(path.join(dir, 'now', 'sub-20260902T091000Z.jpg')));
	assert.ok(fs.existsSync(path.join(dir, 'now', 'status.json')));

	// Second frame, ten minutes later, naming the first as prevKey — the delete branch
	// is the half of dry-run mode the original test never entered, and it is the branch
	// that touches the filesystem by a key rather than by a name this module built.
	// Dry-run intentionally drops Content-Type and Cache-Control: files on disk carry no
	// HTTP metadata, so only the write/delete lifecycle is observable in this mode.
	const later = Object.assign(baseStatus(), { updatedAt: '2026-09-02T09:20:00.000Z' });
	const second = await p.publish({ jpegBuffer: jpeg, status: later, prevKey: first.key, pendingDelete: [] });
	assert.equal(s3.calls.length, 0);
	assert.equal(second.key, 'now/sub-20260902T092000Z.jpg');
	assert.ok(!fs.existsSync(path.join(dir, 'now', 'sub-20260902T091000Z.jpg')), 'the previous frame is gone');
	assert.ok(fs.existsSync(path.join(dir, 'now', 'sub-20260902T092000Z.jpg')));
	assert.deepEqual(second.deleted, [first.key]);
	assert.deepEqual(second.deleteErrors, []);
});

test('state: load() on a missing file yields defaults; save() round-trips', () => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'state-')), 'state.json');
	const st = createState(file);
	assert.deepEqual(st.load(), { lastFilename: null, lastKey: null, pendingDelete: [] });
	// A real key shape, not a bare 'x': SAFE_KEY in publish.js would refuse that
	// one, so the fixture would have been describing a state.json the agent can
	// never write.
	st.save({ lastFilename: 'a.xisf', lastKey: 'now/sub-a.jpg', pendingDelete: ['now/sub-x.jpg'] });
	assert.deepEqual(createState(file).load(), { lastFilename: 'a.xisf', lastKey: 'now/sub-a.jpg', pendingDelete: ['now/sub-x.jpg'] });
});

test('state: load() drops non-string pendingDelete entries', () => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'state-')), 'state.json');
	// Written by hand rather than through save(), because save() round-trips whatever
	// it is given — the realistic source of a bad entry is a hand-edited state.json.
	fs.writeFileSync(file, JSON.stringify({
		lastFilename: 'a.xisf',
		lastKey: 'now/sub-a.jpg',
		pendingDelete: ['now/sub-x.jpg', 42, null, { k: 1 }, 'now/sub-y.jpg'],
	}));
	assert.deepEqual(createState(file).load().pendingDelete, ['now/sub-x.jpg', 'now/sub-y.jpg']);
});

test('publish: an upload that never answers is ended by the deadline, and the error says which object and how long', async () => {
	// The S3 client as agent.js builds it has no deadline of its own (the SDK's
	// Node handler defaults request and socket timeouts to none). No real time
	// passes here: signalFor hands out controllers this test aborts by hand.
	const controllers = [];
	const s3 = {
		send: (cmd, opts) => new Promise((resolve, reject) => {
			// Never answers on its own: only the deadline can end this request. The
			// rejection is shaped like the SDK handler's: name AbortError, a bare message.
			opts.abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })));
		}),
	};
	const signalFor = (ms) => { const c = new AbortController(); controllers.push([ms, c]); return c.signal; };
	const p = createPublisher({ s3, bucket: 'b', publicBaseUrl: 'https://live.dustin.space', timeoutMs: 1234, signalFor });
	const pending = p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: null, pendingDelete: [] });
	await new Promise((r) => setImmediate(r));              // let publish() reach its first send
	assert.equal(controllers.length, 1);
	controllers[0][1].abort();
	await assert.rejects(pending, (err) => {
		assert.equal(err.name, 'AbortError', 'the same error object: its name survives for errorDetail()');
		assert.equal(err.message, 'upload of now/sub-20260902T091000Z.jpg got no answer from R2 within 1234 ms and was aborted');
		assert.equal(err.orphanKey, 'now/sub-20260902T091000Z.jpg');
		return true;
	});
});

test('publish: EVERY request gets its own signal built from the configured deadline', async () => {
	// Identity, not just "a signal": each send must receive the very object
	// signalFor returned for it, and signalFor must have been asked for timeoutMs
	// each time. Checking instanceof alone passed with the delete's deadline
	// multiplied by a thousand.
	const handed = [];
	const got = [];
	const s3 = { send: async (cmd, opts) => { got.push([cmd.constructor.name, opts.abortSignal]); return {}; } };
	const signalFor = (ms) => { const s = new AbortController().signal; handed.push([ms, s]); return s; };
	const p = createPublisher({ s3, bucket: 'b', publicBaseUrl: 'https://live.dustin.space', timeoutMs: 1234, signalFor });
	await p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: 'now/sub-20260901T000000Z.jpg', pendingDelete: [] });
	assert.deepEqual(got.map(g => g[0]), ['PutObjectCommand', 'PutObjectCommand', 'DeleteObjectCommand']);
	assert.deepEqual(handed.map(h => h[0]), [1234, 1234, 1234]);
	got.forEach((g, i) => assert.equal(g[1], handed[i][1], `request ${i} carries the signal made for it`));
});

test('publish: with no overrides the deadline is AbortSignal.timeout(30 s)', async (t) => {
	// The default signalFor is the one production runs. Mocked so no timer is
	// armed; what matters is that it is called, and with the real constant.
	const timeout = t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
	const s3 = { send: async () => ({}) };
	const p = createPublisher({ s3, bucket: 'b', publicBaseUrl: 'https://live.dustin.space' });
	await p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: null, pendingDelete: [] });
	assert.equal(R2_TIMEOUT_MS, 30000);
	assert.deepEqual(timeout.mock.calls.map(c => c.arguments[0]), [30000, 30000]);
});
