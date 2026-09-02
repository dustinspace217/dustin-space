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
	// Two assertions that prove different things. The names prove the command KINDS
	// (two puts, then a delete). The keys prove the ORDER — both puts share one
	// constructor name, so the name list alone cannot see an image/status swap, which
	// is the exact regression the "order is load-bearing" contract exists to stop.
	assert.deepEqual(s3.calls.map(c => c.name), ['PutObjectCommand', 'PutObjectCommand', 'DeleteObjectCommand']);
	assert.deepEqual(s3.calls.map(c => c.input.Key), ['now/sub-20260902T091000Z.jpg', 'now/status.json', 'now/sub-old.jpg']);
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
	assert.deepEqual(r.deleteErrors, []);
});

test('publish: status PUT failure aborts BEFORE any delete (reader never sees a dangling pointer)', async () => {
	const s3 = fakeS3(cmd => cmd.constructor.name === 'PutObjectCommand' && cmd.input.Key === 'now/status.json');
	const p = createPublisher({ s3, bucket: 'b', publicBaseUrl: 'https://live.dustin.space' });
	await assert.rejects(
		p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: 'now/sub-old.jpg', pendingDelete: [] }),
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
	const pending = Array.from({ length: 25 }, (_, i) => `now/sub-p${i}.jpg`);
	const r = await p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: 'now/sub-old.jpg', pendingDelete: pending });
	assert.equal(r.deleted.length, 0);
	assert.equal(r.pendingDelete.length, 20);
	assert.ok(r.pendingDelete.includes('now/sub-old.jpg'), 'the newest failure is kept; oldest are dropped');
	// Every attempted key is reported, not just the 20 that survive the cap: the queue
	// is capped for state.json's sake, but a dropped key is exactly the one the operator
	// most needs to hear about. Count comes from this test's own inputs, not a literal.
	const attempted = pending.length + 1;   // the whole pending queue, plus prevKey
	assert.equal(r.deleteErrors.length, attempted);
	for (const e of r.deleteErrors) {
		assert.equal(typeof e.key, 'string');
		assert.ok(e.message.length > 0, 'every delete error carries a reason to log');
	}
});

test('publish: a key outside now/ is refused, reported once, and never retried', async () => {
	const s3 = fakeS3();
	const p = createPublisher({ s3, bucket: 'b', publicBaseUrl: 'https://live.dustin.space' });
	const r = await p.publish({ jpegBuffer: jpeg, status: baseStatus(), prevKey: null, pendingDelete: ['../x', 'now/sub-ok.jpg'] });
	assert.deepEqual(r.deleted, ['now/sub-ok.jpg']);
	// Refused before the client is touched: only the well-formed key produced a command.
	assert.deepEqual(s3.calls.filter(c => c.name === 'DeleteObjectCommand').map(c => c.input.Key), ['now/sub-ok.jpg']);
	assert.deepEqual(r.deleteErrors, [{ key: '../x', message: 'invalid key' }]);
	// Dropped rather than queued — a malformed key would fail identically forever, so
	// retrying it just holds a slot until it ages out of the cap.
	assert.deepEqual(r.pendingDelete, []);
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
	st.save({ lastFilename: 'a.xisf', lastKey: 'now/sub-a.jpg', pendingDelete: ['x'] });
	assert.deepEqual(createState(file).load(), { lastFilename: 'a.xisf', lastKey: 'now/sub-a.jpg', pendingDelete: ['x'] });
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
