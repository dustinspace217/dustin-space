#!/usr/bin/env node
/**
 * r2-probe.js — prove the R2 token in config.json does what the design says,
 * WITHOUT waiting for the first light frame and WITHOUT the secret leaving
 * the machine it lives on.
 *
 * Usage (from the now-imaging folder, after config.json carries the token):
 *   node tools/r2-probe.js          (or: npm run probe:r2)
 * Run it at install AND after any change to config.json or to the token.
 *
 * Three checks:
 *   1. ListObjectsV2 on the LIVE bucket (config.r2Bucket) must SUCCEED — the
 *      token is valid and can read the bucket it was scoped to.
 *   2. ListObjectsV2 on the TILES bucket ("dustinspace") must be refused with
 *      exactly AccessDenied — the blast-radius promise of spec §8: a token
 *      living on the rig cannot touch the gallery tiles. Three outcomes, not
 *      two: readable = over-scoped (FAIL); AccessDenied = isolated (may PASS);
 *      ANY OTHER error — a timeout, a 5xx, a TLS failure — is INCONCLUSIVE
 *      and also FAILs, because "the call did not succeed" is not evidence of
 *      isolation. (The first version counted every thrown error as "denied",
 *      so one network blip could have certified an over-scoped token.)
 *   3. PutObject then DeleteObject of one tiny scratch key on the LIVE bucket
 *      must both SUCCEED — the token can WRITE, which is the whole job.
 *      Added 2026-09-20: the original two-check probe passed on 2026-09-02
 *      against a token created with "Object Read" only, and the first imaging
 *      night (2026-09-19) then failed every publish for ~20 hours with Access
 *      Denied. A read-only token reads fine; only a write can prove write.
 *
 * The scratch key is the FIXED name now/_probe.txt. Its `_probe` prefix and
 * .txt suffix are what keep it from ever matching a frame key (frames are
 * now/sub-<stamp>.jpg) or now/status.json. A fixed name makes the probe
 * self-healing: if a run dies between the put and the delete, the next run
 * overwrites and removes the leftover, where a timestamped name would have
 * stayed in the public bucket until someone noticed it.
 *
 * Known limit (measured 2026-09-20 with the rig's token): R2 answers a scoped
 * token with AccessDenied 403 for a bucket that DOES NOT EXIST, exactly as it
 * does for one that is out of scope. So this probe cannot tell whether
 * TILES_BUCKET still names the real tiles bucket — if that bucket is ever
 * renamed, update the constant below, or check 2 certifies isolation from a
 * name nobody uses.
 *
 * Exit code 0 only when all three checks land as expected; 1 otherwise, with
 * the reason printed. Check 3 writes and removes one 5-byte object; nothing
 * else is written to either bucket.
 */
'use strict';

const path = require('node:path');
const { S3Client, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { loadConfig } = require('../agent');

// The bucket the token must NOT be able to read. Hard-coded on purpose: the
// point is to name the specific thing we are protecting.
const TILES_BUCKET = 'dustinspace';

// The one object check 3 writes and removes. See the header for why it is a
// fixed name rather than a timestamped one.
const SCRATCH_KEY = 'now/_probe.txt';

// The S3 error name that means "this token may not do that". Compared exactly:
// it is the only refusal that counts as evidence about permissions.
const ACCESS_DENIED = 'AccessDenied';

/**
 * describeError — what a failed SDK call was, in a form worth printing.
 * Receives the thrown value; returns {code, message}.
 *
 * code: the SDK puts the S3 error code in err.name for service errors
 * ('AccessDenied'). For transport failures it throws a plain Error whose name
 * is just 'Error' and whose discriminator is err.code — measured 2026-09-20
 * against a bad endpoint: name 'Error', code 'EPROTO', no HTTP status. So the
 * name is used unless it is the uninformative 'Error', then err.code, then
 * err.Code, then 'UnknownError'.
 * message: kept because for transport failures it is the only place the real
 * reason lives ("getaddrinfo ENOTFOUND …"); a bare code would discard it —
 * the same under-diagnosis the agent's errorDetail() exists to fix.
 * The `err &&` guards are defensive: a thrown primitive has no properties.
 */
function describeError(err) {
	const name = err && typeof err.name === 'string' && err.name !== 'Error' ? err.name : null;
	const code = name || (err && (err.code || err.Code)) || 'UnknownError';
	const message = err && typeof err.message === 'string' ? err.message.trim() : '';
	return { code: String(code), message };
}

/**
 * attempt — run one SDK command and report how it went.
 * Receives the S3 client and a command object; returns {ok: true} or
 * {ok: false, code, message} (see describeError). Never throws: every check
 * in this probe wants the outcome as data so it can print every check's line
 * even when the first one fails.
 */
async function attempt(s3, command) {
	try {
		await s3.send(command);
		return { ok: true };
	} catch (err) {
		return Object.assign({ ok: false }, describeError(err));
	}
}

/**
 * failureText — the words for one failed step. Receives an attempt() result
 * with ok === false; returns `DENIED AccessDenied` for a permission refusal
 * and `FAILED <code>: <message>` for anything else. "Denied" is reserved for
 * the one outcome that is actually a denial; a timeout is not one.
 */
function failureText(result) {
	if (result.code === ACCESS_DENIED) return `DENIED ${result.code}`;
	return `FAILED ${result.code}${result.message ? ': ' + result.message : ''}`;
}

/**
 * runProbe — the whole probe against an injected client, so tests can drive
 * it with a fake `send` and the CLI below can drive it with the real SDK.
 * Receives {s3, liveBucket, tilesBucket, scratchKey, out} where out(line)
 * receives each report line; returns true when every check landed as
 * expected. Exported for tests/now-imaging/r2-probe.test.js.
 *
 * The delete is attempted whatever the put did. Two reasons, both about not
 * leaving an object behind: a put can fail on OUR side after it landed on
 * theirs (a timeout waiting for the response), and deleting a key that is not
 * there is harmless: R2 answers HTTP 204 (measured on the rig 2026-09-20). It
 * also reports the delete permission independently of the put permission.
 */
async function runProbe({ s3, liveBucket, tilesBucket = TILES_BUCKET, scratchKey = SCRATCH_KEY, out = console.log }) {
	const live = await attempt(s3, new ListObjectsV2Command({ Bucket: liveBucket, MaxKeys: 1 }));
	const tiles = await attempt(s3, new ListObjectsV2Command({ Bucket: tilesBucket, MaxKeys: 1 }));
	const put = await attempt(s3, new PutObjectCommand({ Bucket: liveBucket, Key: scratchKey, Body: 'probe', ContentType: 'text/plain' }));
	const del = await attempt(s3, new DeleteObjectCommand({ Bucket: liveBucket, Key: scratchKey }));

	const tilesIsolated = !tiles.ok && tiles.code === ACCESS_DENIED;

	out(`live bucket ${liveBucket}: ${live.ok ? 'readable (expected)' : failureText(live) + ' (unexpected)'}`);
	if (tiles.ok) out(`tiles bucket ${tilesBucket}: READABLE (unexpected: token is over-scoped)`);
	else if (tilesIsolated) out(`tiles bucket ${tilesBucket}: denied ${tiles.code} (expected)`);
	else out(`tiles bucket ${tilesBucket}: INCONCLUSIVE, ${failureText(tiles)} — that is not a permission refusal, so it proves nothing about scope; re-run`);
	out(`write ${scratchKey}: put ${put.ok ? 'ok' : failureText(put)}, delete ${del.ok ? 'ok' : failureText(del)}`
		+ (put.ok && !del.ok ? ` — the scratch object is still in ${liveBucket}; remove it by hand` : ''));

	const pass = live.ok && tilesIsolated && put.ok && del.ok;
	out(pass
		? 'PASS: token is valid, scoped to the live bucket only, and can write'
		: 'FAIL: see above (a token that reads but cannot write was the 2026-09-19 first-night failure)');
	return pass;
}

if (require.main === module) {
	(async () => {
		const cfg = loadConfig(path.join(__dirname, '..', 'config.json'));
		// loadConfig skips the credential checks when dryRunDir is set, because a
		// dry run never touches R2. A probe of that config would be meaningless in
		// both directions: with placeholder credentials it prints failures that
		// read like a permissions problem, and with real ones it prints PASS
		// for an agent that — still in dry-run — will never publish to R2 at all.
		if (cfg.dryRunDir) {
			console.error('probe refused: config.json sets dryRunDir, so the agent is not publishing to R2. Remove dryRunDir, then re-run.');
			process.exit(1);
		}
		const s3 = new S3Client({
			endpoint: `https://${cfg.r2AccountId}.r2.cloudflarestorage.com`,
			region: 'auto',
			credentials: { accessKeyId: cfg.r2AccessKeyId, secretAccessKey: cfg.r2SecretAccessKey },
		});
		const pass = await runProbe({ s3, liveBucket: cfg.r2Bucket });
		process.exit(pass ? 0 : 1);
	})().catch((err) => {
		console.error(`probe failed: ${err.message}`);
		process.exit(1);
	});
}

module.exports = { runProbe, describeError, TILES_BUCKET, SCRATCH_KEY };
