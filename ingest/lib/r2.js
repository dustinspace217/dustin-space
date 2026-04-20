/**
 * r2.js — Cloudflare R2 upload helpers for the ingest pipeline
 *
 * Manages the S3-compatible client for uploading DZI tiles to Cloudflare R2.
 * Uses @aws-sdk/client-s3 — Cloudflare R2 exposes an S3-compatible API, so
 * the standard AWS SDK works with the right endpoint and credentials.
 *
 * Key design choices:
 *   - Lazy client init: S3Client is created on first upload, not at startup.
 *     This means POST /api/settings can update R2 credentials and resetR2Client()
 *     forces a new client with the fresh credentials on the next upload.
 *   - Concurrency pool: uploads N files at a time using a sliding window,
 *     rather than batching in groups. This keeps the upload pipe full.
 *
 * Exports:
 *   getR2Client()       — return or create the singleton S3Client
 *   resetR2Client()     — discard the cached client (call after credential change)
 *   uploadOneToR2(localPath, r2Key)      — upload a single file
 *   uploadDziToR2(dziOutputDir, emitFn)  — upload an entire DZI directory
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getConfig } = require('./config');
const { walkDirAsync } = require('./walk');

// Cloudflare R2 bucket name — the 'dustinspace' bucket is served at tiles.dustin.space.
const R2_BUCKET   = 'dustinspace';
// Public URL prefix for the bucket. DZI URLs are constructed as: R2_BASE_URL + '/' + slug + '.dzi'
const R2_BASE_URL = 'https://tiles.dustin.space';

// Singleton S3Client — created lazily by getR2Client(), reset by resetR2Client().
// This avoids creating a client at startup with potentially-placeholder credentials
// and allows credential changes via POST /api/settings to take effect.
let r2Client = null;

/**
 * getR2Client — return the cached S3Client or create a new one.
 *
 * Reads R2 credentials from the current in-memory config (via getConfig()).
 * The client is cached as a singleton — subsequent calls return the same instance
 * until resetR2Client() is called.
 *
 * @returns {S3Client} configured S3Client pointed at the R2 endpoint
 *
 * S3Client config:
 *   endpoint — R2's S3-compatible URL, built from the account ID
 *   region   — R2 requires the literal string "auto" (not an AWS region)
 *   credentials — access key pair from config.json (gitignored)
 */
function getR2Client() {
	if (!r2Client) {
		const cfg = getConfig();
		r2Client = new S3Client({
			endpoint: `https://${cfg.r2_account_id}.r2.cloudflarestorage.com`,
			region:   'auto',
			credentials: {
				accessKeyId:     cfg.r2_access_key_id,
				secretAccessKey: cfg.r2_secret_access_key,
			},
		});
	}
	return r2Client;
}

/**
 * resetR2Client — discard the cached S3Client.
 *
 * Call this after R2 credentials are changed (e.g. via POST /api/settings)
 * so the next upload creates a fresh client with the new credentials.
 */
function resetR2Client() {
	r2Client = null;
}

/**
 * uploadOneToR2 — upload a single file to R2.
 *
 * @param {string} localPath — absolute path on disk to the file to upload
 * @param {string} r2Key     — the key (path) in the R2 bucket
 *   e.g. "horsehead-nebula.dzi" or "horsehead-nebula_files/12/0_0.jpg"
 * @returns {Promise} resolves when R2 confirms the upload
 *
 * Content-Type is inferred from the file extension. Falls back to
 * application/octet-stream for unknown extensions.
 * fs.createReadStream is used to avoid loading the whole file into memory.
 */
function uploadOneToR2(localPath, r2Key) {
	const ext = path.extname(localPath).toLowerCase();
	// Content-Type map for the file types we upload.
	// .dzi is XML (the DZI descriptor); tiles are JPEG.
	const contentTypes = {
		'.dzi':  'application/xml',
		'.jpg':  'image/jpeg',
		'.jpeg': 'image/jpeg',
		'.png':  'image/png',
		'.webp': 'image/webp',
	};
	const ct = contentTypes[ext] || 'application/octet-stream';

	// Stream the file to avoid buffering large files in memory.
	const body = fs.createReadStream(localPath);
	const cmd  = new PutObjectCommand({
		Bucket:      R2_BUCKET,
		Key:         r2Key,
		Body:        body,
		ContentType: ct,
	});

	// getR2Client() creates the S3Client lazily if it doesn't exist yet.
	return getR2Client().send(cmd);
}

/**
 * uploadOneWithRetry — upload a single file to R2 with retry on failure.
 *
 * @param {string} localPath — absolute path to the file
 * @param {string} r2Key     — R2 object key
 * @param {number} [maxRetries=2] — number of retry attempts after initial failure
 * @returns {Promise<string>} the r2Key on success (for tracking uploaded keys)
 * @throws {Error} if all attempts fail
 */
async function uploadOneWithRetry(localPath, r2Key, maxRetries = 2) {
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			await uploadOneToR2(localPath, r2Key);
			return r2Key;
		} catch (err) {
			if (attempt === maxRetries) {
				throw new Error(`Failed to upload ${r2Key} after ${maxRetries + 1} attempts: ${err.message}`);
			}
			// Brief backoff before retrying (200ms, 400ms).
			await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
		}
	}
}

/**
 * uploadDziToR2 — upload an entire DZI directory to R2 with a sliding-window
 * concurrency pool.
 *
 * Enumerates all files using the async directory walker (non-blocking) and
 * uploads them with bounded concurrency using a true sliding window: when one
 * upload finishes, the next starts immediately — no waiting for a full batch.
 *
 * @param {string} dziOutputDir — local directory containing the .dzi file
 *   and _files/ folder (e.g. /tmp/ingest-<id>/dzi/)
 * @param {function} emitFn — callback for progress updates. Called with
 *   a string message that appears in the ingest UI log.
 * @returns {Promise<{ uploadedKeys: string[], failed: string[] }>}
 *   uploadedKeys — R2 keys that were successfully uploaded (for cancel cleanup)
 *   failed       — R2 keys that failed after all retries
 *
 * Concurrency: 50 parallel uploads. SDK uploads share a single HTTP/2
 * connection pool and have no process-spawn overhead, so high concurrency
 * is safe and efficient.
 */
async function uploadDziToR2(dziOutputDir, emitFn) {
	// Collect all files first using the async walker (non-blocking).
	const allFiles = [];
	for await (const f of walkDirAsync(dziOutputDir)) {
		allFiles.push(f);
	}
	const total = allFiles.length;
	emitFn(`Uploading ${total} DZI files to R2...`);

	// True sliding window: keep exactly CONCURRENCY uploads in flight.
	// When one finishes, the next starts immediately.
	const CONCURRENCY = 50;
	const uploadedKeys = [];
	const failed = [];
	let uploaded = 0;
	let nextIdx  = 0;

	// Start initial batch of CONCURRENCY uploads.
	const inflight = new Set();

	function startNext() {
		if (nextIdx >= allFiles.length) return;
		const f = allFiles[nextIdx++];
		const p = uploadOneWithRetry(f.local, f.rel)
			.then(key => {
				uploadedKeys.push(key);
				uploaded++;
				// Emit progress every 50 uploads or on the last file.
				if (uploaded % 50 === 0 || uploaded === total) {
					emitFn(`R2 upload: ${uploaded}/${total}`);
				}
			})
			.catch(err => {
				failed.push(f.rel);
				uploaded++;
				console.error(`[r2] Upload failed: ${err.message}`);
			})
			.finally(() => {
				inflight.delete(p);
				startNext();
			});
		inflight.add(p);
	}

	// Fill the initial window.
	for (let i = 0; i < Math.min(CONCURRENCY, allFiles.length); i++) {
		startNext();
	}

	// Wait for all inflight uploads to finish.
	// We need to keep checking because inflight is a dynamic set.
	while (inflight.size > 0) {
		await Promise.race(inflight);
	}

	if (failed.length > 0) {
		emitFn(`Warning: ${failed.length} file(s) failed to upload after retries.`);
	}

	return { uploadedKeys, failed };
}

module.exports = {
	R2_BUCKET,
	R2_BASE_URL,
	getR2Client,
	resetR2Client,
	uploadOneToR2,
	uploadOneWithRetry,
	uploadDziToR2,
};
