#!/usr/bin/env node
/**
 * r2-probe.js — prove the R2 token in config.json does what the design says,
 * WITHOUT waiting for the first light frame and WITHOUT the secret leaving
 * the machine it lives on.
 *
 * Usage (from the now-imaging folder, after config.json carries the token):
 *   node tools/r2-probe.js
 *
 * Two checks, both read-only:
 *   1. ListObjectsV2 on the LIVE bucket (config.r2Bucket) must SUCCEED — the
 *      token is valid and can read the bucket it was scoped to.
 *   2. ListObjectsV2 on the TILES bucket ("dustinspace") must be DENIED — the
 *      blast-radius promise of spec §8: a token living on the rig cannot touch
 *      the gallery tiles. If this call succeeds, the token was created with the
 *      wrong scope and must be rotated before the agent runs.
 *
 * Exit code 0 only when both checks land as expected; 1 otherwise, with the
 * reason printed. Nothing is written to either bucket.
 */
'use strict';

const path = require('node:path');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { loadConfig } = require('../agent');

// The bucket the token must NOT be able to read. Hard-coded on purpose: the
// point is to name the specific thing we are protecting.
const TILES_BUCKET = 'dustinspace';

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
		return { ok: false, code: err && (err.name || err.Code) || 'UnknownError' };
	}
}

(async () => {
	const cfg = loadConfig(path.join(__dirname, '..', 'config.json'));
	const s3 = new S3Client({
		endpoint: `https://${cfg.r2AccountId}.r2.cloudflarestorage.com`,
		region: 'auto',
		credentials: { accessKeyId: cfg.r2AccessKeyId, secretAccessKey: cfg.r2SecretAccessKey },
	});

	const live = await listOnce(s3, cfg.r2Bucket);
	const tiles = await listOnce(s3, TILES_BUCKET);
	console.log(`live bucket ${cfg.r2Bucket}: ${live.ok ? 'readable (expected)' : 'DENIED ' + live.code + ' (unexpected)'}`);
	console.log(`tiles bucket ${TILES_BUCKET}: ${tiles.ok ? 'READABLE (unexpected: token is over-scoped)' : 'denied ' + tiles.code + ' (expected)'}`);

	const pass = live.ok && !tiles.ok;
	console.log(pass ? 'PASS: token is valid and scoped to the live bucket only' : 'FAIL: see above');
	process.exit(pass ? 0 : 1);
})().catch((err) => {
	console.error(`probe failed: ${err.message}`);
	process.exit(1);
});
