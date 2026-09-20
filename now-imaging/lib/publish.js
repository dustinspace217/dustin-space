/**
 * publish.js — write the frame + status to R2 (or to a dry-run directory).
 *
 * ORDER IS LOAD-BEARING (spec §5.5): image first, then status, then delete the
 * previous image. A reader that fetches status.json at any instant therefore
 * sees a URL that already exists. Reversing the order would let the homepage
 * 404 on the frame for the seconds between the two PUTs.
 *
 * The JPEG key is VERSIONED by the frame timestamp, so a cached copy can never
 * be stale (immutable, for the one day FRAME_CACHE_CONTROL allows); status.json
 * is what changes. Cloudflare's CDN decides
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

// The only shape of key this module will ever delete: exactly what keyForFrame
// produces, now/sub-<YYYYMMDD>T<HHMMSS>Z.jpg. (An earlier, looser pattern —
// any flat filename under now/ — also admitted now/status.json, now/. and
// now/.., against its own comment.)
// Deliberately an allow-list rather than a '..' blacklist — in dry-run mode the key
// is path.join'd under dryRunDir, so a key containing '..' resolves OUTSIDE that
// directory and would delete a real file. Every key this module produces
// (keyForFrame) matches, so a key that does not match came from somewhere else —
// a hand-edited state.json — and is refused. See del().
const SAFE_KEY = /^now\/sub-\d{8}T\d{6}Z\.jpg$/;

// Deadline for ONE s3.send() call as a whole, whatever retrying the SDK does
// inside it: the signal is built once per call, and once it has fired every
// further attempt on it is refused at once. The S3 client as this agent builds it has no
// deadline of its own: the SDK's Node HTTP handler defaults its request timeout
// to 0 (none), and a configured one only logs a warning unless
// throwOnRequestTimeout is also set (read in @smithy/node-http-handler 4.12.0,
// the installed version). An abort signal per call is the one form that
// actually ends the request. A request that is accepted and never answered
// would hang its await forever, and check() holds a one-at-a-time latch across
// that await — so every later trigger would return early, silently, for as long
// as the process lived. 30 s is far above a normal PUT of a ~450 KB frame.
const R2_TIMEOUT_MS = 30000;

// How long the delete loop at the end of publish() may keep STARTING deletes.
// Deletes run one after another, each with its own R2_TIMEOUT_MS, and the queue
// holds up to MAX_PENDING_DELETE + 1 keys: against a bucket that accepts requests
// and never answers, that is over ten minutes inside one pass. Cleanup is not
// worth holding the publisher's latch that long, and whatever is not attempted
// goes straight back on the queue for the next publish. With this, the longest
// honest pass is about three minutes (see STUCK_AFTER_MS in agent.js).
const DELETE_BUDGET_MS = 60000;

// How long browsers and Cloudflare's edge may keep a frame. A frame's key is
// unique and its bytes never change, hence "immutable"; but each frame is only
// referenced for minutes, and a DELETE does not evict cached copies, so a
// one-year lifetime (the first version) only meant a removed frame stayed
// fetchable for a year. One day is plenty for repeat visitors.
const FRAME_CACHE_CONTROL = 'public, max-age=86400, immutable';

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
 * timeoutMs / signalFor are the per-request deadline (see R2_TIMEOUT_MS) and the
 * function that turns it into an AbortSignal; both exist as parameters only so
 * a test can hand in a signal it aborts by hand, with no real time passing.
 * AbortSignal.timeout(ms) is a built-in (Node 17.3+) that aborts itself after ms.
 * deleteBudgetMs / now are the delete loop's time budget (see DELETE_BUDGET_MS)
 * and its clock, parameters for the same reason.
 * Returns {publish}.
 */
function createPublisher({ s3, bucket, publicBaseUrl, dryRunDir = null, timeoutMs = R2_TIMEOUT_MS, signalFor = (ms) => AbortSignal.timeout(ms), deleteBudgetMs = DELETE_BUDGET_MS, now = Date.now }) {
	const base = String(publicBaseUrl).replace(/\/+$/, '');

	/**
	 * send — one S3 command under the per-request deadline.
	 * Receives the command, a verb and the key (both only for the message).
	 * When OUR deadline ends the request, the SDK's handler throws a bare
	 * "Request aborted" (name AbortError) that names neither the object nor the
	 * limit, and that is all the log line would say. The message is rewritten
	 * in place — the same error object is rethrown, so its name and stack
	 * survive and errorDetail() in agent.js still appends "(AbortError)".
	 */
	async function send(command, verb, key) {
		try {
			return await s3.send(command, { abortSignal: signalFor(timeoutMs) });
		} catch (err) {
			if (err !== null && typeof err === 'object' && err.name === 'AbortError') {
				err.message = `${verb} of ${key} got no answer from R2 within ${timeoutMs} ms and was aborted`;
			}
			throw err;
		}
	}

	/**
	 * tagOrphan — mark a thrown PUT error with the JPEG key that may now be in R2
	 * with nothing pointing at it. Guarded: a thrown primitive (a bare string,
	 * undefined) cannot carry a property, and assigning to one under 'use strict'
	 * throws a TypeError that would replace the real failure with a misleading one.
	 */
	function tagOrphan(err, key) {
		if (err !== null && typeof err === 'object') err.orphanKey = key;
		return err;
	}

	/** put — one object write, to disk in dry-run mode. */
	async function put(key, body, contentType, cacheControl) {
		if (dryRunDir) {
			const file = path.join(dryRunDir, key);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, body);
			return;
		}
		await send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl }), 'upload', key);
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
			await send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), 'delete', key);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err, retry: true };
		}
	}

	/**
	 * publish — receives {jpegBuffer, status (frame.url already set by the caller; re-assigned here from the same derivation), prevKey|null,
	 * pendingDelete[]}. Fills status.frame.url, runs the ordered sequence, and
	 * returns:
	 *   key, url        — where this frame was written
	 *   deleted[]       — keys whose delete SUCCEEDED on this run (a delete of an
	 *                     already-absent key succeeds, in R2 and in dry-run alike)
	 *   pendingDelete[] — keys whose delete failed and is WORTH RETRYING, newest
	 *                     MAX_PENDING_DELETE kept; a malformed key is not here
	 *   deleteErrors[]  — {key, message, error} for EVERY delete that failed this
	 *                     run, retryable or not, so the caller can log why. `error`
	 *                     is the thrown value itself: the message of an R2 refusal
	 *                     ("Access Denied") does not say which refusal, and the
	 *                     caller's errorDetail() reads the name and HTTP status off
	 *                     the object. Empty when all deletes succeeded. Without it
	 *                     a failure is invisible: pendingDelete alone says a key
	 *                     survived, never why.
	 *   skipped[]       — keys not ATTEMPTED because the delete budget ran out;
	 *                     they are in pendingDelete too
	 *   dropped[]       — keys that fell off the front of the queue because it was
	 *                     over MAX_PENDING_DELETE. Nothing will ever delete these:
	 *                     each is a public object left behind, so the caller says so
	 * Throws if either PUT fails, and nothing is deleted in that case. A failure
	 * tags the thrown error with err.orphanKey = the JPEG key whenever that object
	 * is, or may be, in R2 with nothing pointing at it, so the caller can queue it
	 * for deletion instead of leaking it. For the status PUT the JPEG is certainly
	 * there. For the JPEG PUT it may be: a request that R2 completed but whose
	 * answer never arrived (the deadline above makes that more likely, not less)
	 * fails HERE and lands THERE — unless R2 answered with a 4xx, which settles
	 * that it did not (see the catch). Deleting a key that turns out to be absent
	 * costs nothing — R2 answers 204 (measured 2026-09-20).
	 */
	async function publish({ jpegBuffer, status, prevKey, pendingDelete }) {
		const key = keyForFrame(status.updatedAt);
		const url = `${base}/${key}`;
		status.frame.url = url;

		try {
			await put(key, jpegBuffer, 'image/jpeg', FRAME_CACHE_CONTROL);
		} catch (err) {
			// Tag only when the outcome is UNKNOWN. A 4xx is R2 answering "no": the
			// object was not stored, and there is nothing to clean up. Tagging those
			// would be worse than useless — a night of refusals (the first night's
			// read-only token refused every frame for 21 hours) would queue one
			// phantom key per frame, push real entries out of the 20-key queue, and
			// end in ERROR lines about objects that never existed. No status at all
			// (our deadline, a dropped connection) or a 5xx leaves it open.
			const http = err && err.$metadata ? err.$metadata.httpStatusCode : undefined;
			const refused = Number.isInteger(http) && http >= 400 && http < 500;
			throw refused ? err : tagOrphan(err, key);
		}

		// The JPEG is in R2 by this line. If the status PUT fails we must still throw
		// — a reader may never see a status pointing at a frame that isn't there — but
		// the object we just wrote is now referenced by nothing and would leak. Tag the
		// error with its key so the caller can queue it for deletion. The ORIGINAL
		// error is rethrown, not a wrapper, so its message and stack survive.
		try {
			await put('now/status.json', JSON.stringify(status), 'application/json', 'no-cache');
		} catch (err) {
			throw tagOrphan(err, key);
		}

		// A failed status PUT can queue this same JPEG as an orphan. On retry it
		// becomes current, so exclude it from BOTH cleanup sources; stale keys stay.
		const toDelete = [...(pendingDelete || []), ...(prevKey ? [prevKey] : [])].filter(k => k !== key);
		const deleted = [];
		const stillPending = [];
		const deleteErrors = [];
		const skipped = [];
		const deleteStarted = now();
		// Bounded by the caller's list: every publish caps what it hands back at
		// MAX_PENDING_DELETE, so a queue this function itself grew is ≤ MAX+1 here.
		// The cap is applied on the way OUT (below), not re-checked on the way in —
		// a hand-edited state.json could pass a longer list, which costs one extra
		// pass of doomed deletes and is then trimmed to the cap anyway.
		for (const k of toDelete) {
			// Out of time: do not START another delete. The key is kept, in order.
			if (now() - deleteStarted > deleteBudgetMs) {
				skipped.push(k);
				stillPending.push(k);
				continue;
			}
			const outcome = await del(k);
			if (outcome.ok) {
				deleted.push(k);
				continue;
			}
			// Every failure is reported (spec §5.5: delete failures are "logged and
			// retried"); only the retryable ones go back on the queue.
			deleteErrors.push({ key: k, message: outcome.error.message, error: outcome.error });
			if (outcome.retry) stillPending.push(k);
		}
		// Newest MAX_PENDING_DELETE kept. What the cap cuts is returned, not just
		// lost: slice(-N) alone dropped those keys without a word.
		const dropped = stillPending.slice(0, Math.max(0, stillPending.length - MAX_PENDING_DELETE));
		return { key, url, deleted, pendingDelete: stillPending.slice(-MAX_PENDING_DELETE), deleteErrors, skipped, dropped };
	}

	return { publish };
}

module.exports = { createPublisher, keyForFrame, MAX_PENDING_DELETE, R2_TIMEOUT_MS, DELETE_BUDGET_MS, FRAME_CACHE_CONTROL };
