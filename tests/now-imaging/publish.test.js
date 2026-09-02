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
