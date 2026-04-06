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
const { walkDir }   = require('./walk');

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
 * uploadDziToR2 — upload an entire DZI directory to R2 with a concurrency pool.
 *
 * Enumerates all files in the DZI output directory (the .dzi descriptor +
 * the _files/ tile tree) and uploads them with bounded concurrency.
 *
 * @param {string} dziOutputDir — local directory containing the .dzi file
 *   and _files/ folder (e.g. /tmp/ingest-<id>/dzi/)
 * @param {function} emitFn — callback for progress updates. Called with
 *   a string message that appears in the ingest UI log.
 * @returns {Promise<void>} resolves when all files are uploaded
 *
 * Concurrency: 50 parallel uploads. SDK uploads share a single HTTP/2
 * connection pool and have no process-spawn overhead, so high concurrency
 * is safe and efficient.
 */
async function uploadDziToR2(dziOutputDir, emitFn) {
	const allFiles = [...walkDir(dziOutputDir)];
	const total    = allFiles.length;
	emitFn(`Uploading ${total} DZI files to R2...`);

	// Concurrency pool — upload CONCURRENCY files at a time.
	const CONCURRENCY = 50;
	let uploaded = 0;
	for (let i = 0; i < allFiles.length; i += CONCURRENCY) {
		const batch = allFiles.slice(i, i + CONCURRENCY);
		await Promise.all(batch.map(f => uploadOneToR2(f.local, f.rel)));
		uploaded += batch.length;
		emitFn(`R2 upload: ${uploaded}/${total}`);
	}
}

module.exports = {
	R2_BUCKET,
	R2_BASE_URL,
	getR2Client,
	resetR2Client,
	uploadOneToR2,
	uploadDziToR2,
};
