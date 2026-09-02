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

	/** del — one delete; returns true on success, false on failure (caller queues a retry). */
	async function del(key) {
		try {
			if (dryRunDir) { fs.rmSync(path.join(dryRunDir, key), { force: true }); return true; }
			await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * publish — receives {jpegBuffer, status (frame.url unset), prevKey|null,
	 * pendingDelete[]}. Fills status.frame.url, runs the ordered sequence, and
	 * returns {key, url, deleted[], pendingDelete[]}. Throws if either PUT fails
	 * (nothing is deleted in that case).
	 */
	async function publish({ jpegBuffer, status, prevKey, pendingDelete }) {
		const key = keyForFrame(status.updatedAt);
		const url = `${base}/${key}`;
		status.frame.url = url;

		await put(key, jpegBuffer, 'image/jpeg', 'public, max-age=31536000, immutable');
		await put('now/status.json', JSON.stringify(status), 'application/json', 'no-cache');

		// Everything that should no longer exist: prior failures first, then the key we just replaced.
		const toDelete = [...(pendingDelete || []), ...(prevKey && prevKey !== key ? [prevKey] : [])];
		const deleted = [];
		const stillPending = [];
		// Bounded by the caller's list: every publish caps what it hands back at
		// MAX_PENDING_DELETE, so a queue this function itself grew is ≤ MAX+1 here.
		// The cap is applied on the way OUT (below), not re-checked on the way in —
		// a hand-edited state.json could pass a longer list, which costs one extra
		// pass of doomed deletes and is then trimmed to the cap anyway.
		for (const k of toDelete) {
			if (await del(k)) deleted.push(k); else stillPending.push(k);
		}
		return { key, url, deleted, pendingDelete: stillPending.slice(-MAX_PENDING_DELETE) };
	}

	return { publish };
}

module.exports = { createPublisher, keyForFrame, MAX_PENDING_DELETE };
