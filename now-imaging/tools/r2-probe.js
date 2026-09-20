#!/usr/bin/env node
/**
 * r2-probe.js — prove the R2 token in config.json does what the design says,
 * WITHOUT waiting for the first light frame and WITHOUT the secret leaving
 * the machine it lives on.
 *
 * Usage (from the now-imaging folder, after config.json carries the token):
 *   node tools/r2-probe.js
 *
 * Three checks:
 *   1. ListObjectsV2 on the LIVE bucket (config.r2Bucket) must SUCCEED — the
 *      token is valid and can read the bucket it was scoped to.
 *   2. ListObjectsV2 on the TILES bucket ("dustinspace") must be DENIED — the
 *      blast-radius promise of spec §8: a token living on the rig cannot touch
 *      the gallery tiles. If this call succeeds, the token was created with the
 *      wrong scope and must be rotated before the agent runs.
 *   3. PutObject then DeleteObject of one tiny scratch key on the LIVE bucket
 *      must both SUCCEED — the token can WRITE, which is the whole job.
 *      Added 2026-09-20: the original two-check probe passed on 2026-09-02
 *      against a token created with "Object Read" only, and the first imaging
 *      night (2026-09-19) then failed every publish for ~20 hours with Access
 *      Denied. A read-only token reads fine; only a write can prove write.
 *      The scratch key is one text file under now/ named with a timestamp so
 *      it can never collide with a frame key (frames are now/sub-*.jpg), and
 *      the delete runs even when the put fails, so a half-permitted token
 *      (put yes, delete no) is reported rather than leaving the key behind
 *      unnamed.
 *
 * Exit code 0 only when all three checks land as expected; 1 otherwise, with
 * the reason printed. Check 3 writes and removes one ~5-byte object; nothing
 * else is written to either bucket.
 */
'use strict';

const path = require('node:path');
const { S3Client, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { loadConfig } = require('../agent');

// The bucket the token must NOT be able to read. Hard-coded on purpose: the
// point is to name the specific thing we are protecting.
const TILES_BUCKET = 'dustinspace';

/**
 * errorCode — the SDK's name for a failed call. Receives the thrown value;
 * returns err.name, else err.Code, else 'UnknownError'. Guarded because the
 * SDK can throw non-Error values on transport failures.
 */
function errorCode(err) {
	return (err && (err.name || err.Code)) || 'UnknownError';
}

/**
 * listOnce — one ListObjectsV2 call, capped at one key so the probe is cheap.
 * Receives the S3 client and a bucket name; returns {ok: true} or
 * {ok: false, code} where code is the SDK's error name (e.g. AccessDenied).
 */
async function listOnce(s3, bucket) {
	try {
		await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
		return { ok: true };
	} catch (err) {
		return { ok: false, code: errorCode(err) };
	}
}

/**
 * writeOnce — PutObject then DeleteObject of one scratch key.
 * Receives the S3 client, the bucket, and the key; returns
 * {put: {ok, code?}, del: {ok, code?}}. The delete is attempted regardless of
 * the put's outcome: deleting a key that was never written is a harmless
 * no-op on S3/R2, and a put that succeeded must not leave its key behind.
 */
async function writeOnce(s3, bucket, key) {
	const result = { put: { ok: true }, del: { ok: true } };
	try {
		await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'probe', ContentType: 'text/plain' }));
	} catch (err) {
		result.put = { ok: false, code: errorCode(err) };
	}
	try {
		await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
	} catch (err) {
		result.del = { ok: false, code: errorCode(err) };
	}
	return result;
}

/**
 * runProbe — the whole probe against an injected client, so tests can drive
 * it with a fake `send` and the CLI below can drive it with the real SDK.
 * Receives {s3, liveBucket, tilesBucket, scratchKey, out} where out(line)
 * receives each report line; returns true when every check landed as
 * expected. Exported for tests/now-imaging/r2-probe.test.js.
 */
async function runProbe({ s3, liveBucket, tilesBucket = TILES_BUCKET, scratchKey, out = console.log }) {
	const live = await listOnce(s3, liveBucket);
	const tiles = await listOnce(s3, tilesBucket);
	const write = await writeOnce(s3, liveBucket, scratchKey);

	out(`live bucket ${liveBucket}: ${live.ok ? 'readable (expected)' : 'DENIED ' + live.code + ' (unexpected)'}`);
	out(`tiles bucket ${tilesBucket}: ${tiles.ok ? 'READABLE (unexpected: token is over-scoped)' : 'denied ' + tiles.code + ' (expected)'}`);
	out(`write ${scratchKey}: put ${write.put.ok ? 'ok' : 'DENIED ' + write.put.code}, delete ${write.del.ok ? 'ok' : 'DENIED ' + write.del.code}`
		+ (write.put.ok && !write.del.ok ? ` — the scratch object is still in ${liveBucket}; remove it by hand` : ''));

	const pass = live.ok && !tiles.ok && write.put.ok && write.del.ok;
	out(pass
		? 'PASS: token is valid, scoped to the live bucket only, and can write'
		: 'FAIL: see above (a token that reads but cannot write was the 2026-09-19 first-night failure)');
	return pass;
}

/**
 * scratchKeyNow — the scratch key for one probe run. Receives a Date; returns
 * `now/_probe-<compact UTC stamp>.txt`. The underscore-prefixed, .txt-suffixed
 * name cannot match keyForFrame's `now/sub-<stamp>.jpg`, so a leftover from a
 * half-failed probe is unmistakable in a bucket listing.
 */
function scratchKeyNow(date) {
	return `now/_probe-${date.toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z.txt`;
}

if (require.main === module) {
	(async () => {
		const cfg = loadConfig(path.join(__dirname, '..', 'config.json'));
		const s3 = new S3Client({
			endpoint: `https://${cfg.r2AccountId}.r2.cloudflarestorage.com`,
			region: 'auto',
			credentials: { accessKeyId: cfg.r2AccessKeyId, secretAccessKey: cfg.r2SecretAccessKey },
		});
		const pass = await runProbe({ s3, liveBucket: cfg.r2Bucket, scratchKey: scratchKeyNow(new Date()) });
		process.exit(pass ? 0 : 1);
	})().catch((err) => {
		console.error(`probe failed: ${err.message}`);
		process.exit(1);
	});
}

module.exports = { runProbe, scratchKeyNow, TILES_BUCKET };
