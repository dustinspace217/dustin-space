/**
 * publish.js — write the frame + status to R2 (or to a dry-run directory).
 *
 * ORDER IS LOAD-BEARING (spec §5.5): image first, then status, then delete the
 * previous image. A reader that fetches status.json at any instant therefore
 * sees a URL that already exists. Reversing the order would let the homepage
 * 404 on the frame for the seconds between the two PUTs.
 *
 * The JPEG key is VERSIONED by the frame timestamp so Cloudflare may cache it
 * forever (immutable); status.json is what changes. Cloudflare's CDN decides
 * default cache eligibility by FILE EXTENSION, and .json is not on that list
 * (Default Cache Behavior → "Default cached file extensions", checked
 * 2026-09-01), so status.json is not edge-cached by default — the no-cache
 * header is belt-and-braces against a future "cache everything" rule.
 */
'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

// pendingDelete is bounded: a persistent delete failure must not grow state.json forever.
const MAX_PENDING_DELETE = 20;

// The only shape of key this module will ever delete: a flat filename under now/.
// Deliberately an allow-list rather than a '..' blacklist — in dry-run mode the key
// is path.join'd under dryRunDir, so a key containing '..' resolves OUTSIDE that
// directory and would delete a real file. Every key this module produces
// (keyForFrame) matches, so a key that does not match came from somewhere else —
// a hand-edited state.json — and is refused. See del().
const SAFE_KEY = /^now\/[A-Za-z0-9._-]+$/;

/**
 * keyForFrame — versioned object key from the frame's UTC timestamp.
 * Receives an ISO string; returns 'now/sub-YYYYMMDDTHHMMSSZ.jpg'.
 */
function keyForFrame(updatedAtIso) {
	const compact = new Date(Date.parse(updatedAtIso)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
	return `now/sub-${compact}.jpg`;
}

/**
 * createPublisher — receives an S3Client-compatible object ({send}), the bucket
 * name, the public base URL (custom domain), and an optional dryRunDir.
 * Returns {publish}.
 */
function createPublisher({ s3, bucket, publicBaseUrl, dryRunDir = null }) {
	const base = String(publicBaseUrl).replace(/\/+$/, '');

	/** put — one object write, to disk in dry-run mode. */
	async function put(key, body, contentType, cacheControl) {
		if (dryRunDir) {
			const file = path.join(dryRunDir, key);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, body);
			return;
		}
		await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl }));
	}

	/**
	 * del — one delete attempt for one key.
	 * Receives an object key. Returns {ok: true} on success, or
	 * {ok: false, error, retry} on failure, where `error` is the reason (the caller
	 * reports it) and `retry` says whether queueing the key for another attempt
	 * could ever help. A failed delete is returned, never thrown: cleanup that
	 * fails must not abort a publish whose two writes already succeeded.
	 */
	async function del(key) {
		// Refused before touching the filesystem or R2. A malformed key is not a
		// transient failure — it would fail identically on every future publish — so
		// retry:false drops it instead of pinning it in the queue until it ages out.
		if (!SAFE_KEY.test(key)) return { ok: false, error: new Error('invalid key'), retry: false };
		try {
			if (dryRunDir) { fs.rmSync(path.join(dryRunDir, key), { force: true }); return { ok: true }; }
			await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err, retry: true };
		}
	}

	/**
	 * publish — receives {jpegBuffer, status (frame.url unset), prevKey|null,
	 * pendingDelete[]}. Fills status.frame.url, runs the ordered sequence, and
	 * returns:
	 *   key, url        — where this frame was written
	 *   deleted[]       — keys whose delete SUCCEEDED on this run (a delete of an
	 *                     already-absent key succeeds, in R2 and in dry-run alike)
	 *   pendingDelete[] — keys whose delete failed and is WORTH RETRYING, newest
	 *                     MAX_PENDING_DELETE kept; a malformed key is not here
	 *   deleteErrors[]  — {key, message} for EVERY delete that failed this run,
	 *                     retryable or not, so the caller can log why. Empty when
	 *                     all deletes succeeded. Without it a failure is invisible:
	 *                     pendingDelete alone says a key survived, never why.
	 * Throws if either PUT fails, and nothing is deleted in that case. A status-PUT
	 * failure additionally tags the thrown error with err.orphanKey = the JPEG key
	 * already written, so the caller can queue that now-unreferenced object for
	 * deletion instead of leaking it.
	 */
	async function publish({ jpegBuffer, status, prevKey, pendingDelete }) {
		const key = keyForFrame(status.updatedAt);
		const url = `${base}/${key}`;
		status.frame.url = url;

		await put(key, jpegBuffer, 'image/jpeg', 'public, max-age=31536000, immutable');

		// The JPEG is in R2 by this line. If the status PUT fails we must still throw
		// — a reader may never see a status pointing at a frame that isn't there — but
		// the object we just wrote is now referenced by nothing and would leak. Tag the
		// error with its key so the caller can queue it for deletion. The ORIGINAL
		// error is rethrown, not a wrapper, so its message and stack survive.
		try {
			await put('now/status.json', JSON.stringify(status), 'application/json', 'no-cache');
		} catch (err) {
			// Guard the assignment: a thrown primitive (a bare string, undefined) cannot
			// carry a property, and assigning to one under 'use strict' throws a
			// TypeError that would replace the real failure with a misleading one.
			if (err !== null && typeof err === 'object') err.orphanKey = key;
			throw err;
		}

		// Everything that should no longer exist: prior failures first, then the key we just replaced.
		const toDelete = [...(pendingDelete || []), ...(prevKey && prevKey !== key ? [prevKey] : [])];
		const deleted = [];
		const stillPending = [];
		const deleteErrors = [];
		// Bounded by the caller's list: every publish caps what it hands back at
		// MAX_PENDING_DELETE, so a queue this function itself grew is ≤ MAX+1 here.
		// The cap is applied on the way OUT (below), not re-checked on the way in —
		// a hand-edited state.json could pass a longer list, which costs one extra
		// pass of doomed deletes and is then trimmed to the cap anyway.
		for (const k of toDelete) {
			const outcome = await del(k);
			if (outcome.ok) {
				deleted.push(k);
				continue;
			}
			// Every failure is reported (spec §5.5: delete failures are "logged and
			// retried"); only the retryable ones go back on the queue.
			deleteErrors.push({ key: k, message: outcome.error.message });
			if (outcome.retry) stillPending.push(k);
		}
		return { key, url, deleted, pendingDelete: stillPending.slice(-MAX_PENDING_DELETE), deleteErrors };
	}

	return { publish };
}

module.exports = { createPublisher, keyForFrame, MAX_PENDING_DELETE };
