/**
 * routes/process.js — Pipeline execution and job management routes
 *
 * Handles the three endpoints that manage ingest pipeline jobs:
 *   POST   /api/process         — start a new pipeline job
 *   GET    /api/progress/:jobId — SSE stream of pipeline progress events
 *   DELETE /api/jobs/:jobId     — cancel a running job
 *
 * The POST endpoint accepts multipart form data (JPG + optional TIF) via multer,
 * creates a job in the in-memory job store, starts the pipeline asynchronously,
 * and returns the jobId immediately. The client then connects to the SSE endpoint
 * to receive real-time progress updates.
 *
 * @param {object} opts — dependencies injected from server.js:
 *   upload       — multer instance (configured with dest + fileSize limit)
 *   runPipeline  — the pipeline orchestrator function from server.js (or lib/pipeline.js)
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const { jobs, jobEmit, recordTombstone, getTombstone } = require('../lib/jobs');

/**
 * createProcessRouter — factory function that returns an Express Router
 * with the three pipeline management routes mounted.
 *
 * Uses a factory pattern because the router needs access to the multer instance
 * and runPipeline function, which are configured in server.js.
 *
 * @param {object} opts
 * @param {object} opts.upload      — multer instance for file uploads
 * @param {function} opts.runPipeline — async function(jobId, files, body) that runs the pipeline
 * @returns {Router} Express Router with POST /process, GET /progress/:jobId, DELETE /jobs/:jobId
 */
function createProcessRouter({ upload, runPipeline }) {
	const router = Router();

	// ─── POST /process ───────────────────────────────────────────────────────
	// Accepts multipart form data with files (jpg, tif) and form fields.
	// Returns { jobId } immediately; client connects to GET /progress/:jobId for SSE.
	router.post('/process',
		upload.fields([
			{ name: 'jpg', maxCount: 1 },
			{ name: 'tif', maxCount: 1 },
			{ name: 'xisf', maxCount: 1 },
		]),
		(req, res) => {
			const jobId = crypto.randomUUID();
			// cancelled — set to true by DELETE /jobs/:jobId; checked between
			// pipeline steps so the run can exit cleanly without treating it as an error.
			jobs.set(jobId, { events: [], listeners: [], status: 'running', cancelled: false });

			// Start the pipeline asynchronously so we can return the jobId immediately.
			// Both guards for the same reason: on a non-multipart POST multer leaves
			// req.files unset and (under Express 5) req.body undefined; the pipeline
			// then reports "No JPG file provided" instead of a TypeError on body.mode.
			runPipeline(jobId, req.files || {}, req.body || {})
				.catch(err => {
					// Pipeline already emits its own error+done events in its catch block,
					// but if something truly unexpected escapes, emit here as a safety net.
					jobEmit(jobId, { type: 'error', message: err.message });
					jobEmit(jobId, { type: 'done', slug: null, error: err.message });
				})
				.finally(() => {
					// Always mark the job as done so SSE clients can disconnect cleanly.
					// Previously only set in .then(), so errors left status as 'running'.
					const job = jobs.get(jobId);
					if (job) job.status = 'done';
					// Remove the job from memory after 30 minutes.
					// The client receives all events well before then; this prevents
					// the jobs Map from growing indefinitely across many ingest runs.
					// Before deleting, leave a tombstone (the terminal 'done' line) so
					// a client reconnecting after the 30-min window still gets a proper
					// terminal event instead of a bare 404. Issue W3.
					setTimeout(() => {
						const expiring = jobs.get(jobId);
						if (expiring) recordTombstone(jobId, expiring);
						jobs.delete(jobId);
					}, 30 * 60 * 1000);
				});

			res.json({ jobId });
		}
	);

	// ─── GET /progress/:jobId ────────────────────────────────────────────────
	// Server-Sent Events stream for pipeline progress.
	// Replays any buffered events so the client can reconnect and catch up.
	router.get('/progress/:jobId', (req, res) => {
		const job = jobs.get(req.params.jobId);
		if (!job) {
			// The job may have finished and been garbage-collected (30-min
			// window). If a tombstone exists, replay its terminal event over a
			// short-lived SSE stream so the client settles cleanly rather than
			// interpreting a 404 as an error. No tombstone → genuinely unknown
			// jobId, so 404 is correct. Issue W3.
			const tombstone = getTombstone(req.params.jobId);
			if (tombstone) {
				res.setHeader('Content-Type',  'text/event-stream');
				res.setHeader('Cache-Control', 'no-cache');
				res.setHeader('Connection',    'keep-alive');
				res.flushHeaders();
				res.write(tombstone);
				return res.end();
			}
			return res.status(404).json({ error: 'Job not found' });
		}

		// SSE headers: text/event-stream content type, no caching, keep connection alive.
		res.setHeader('Content-Type',  'text/event-stream');
		res.setHeader('Cache-Control', 'no-cache');
		res.setHeader('Connection',    'keep-alive');
		res.flushHeaders();

		// Replay buffered events for reconnecting clients.
		job.events.forEach(line => res.write(line));

		if (job.status === 'done') {
			return res.end();
		}

		// Register as a live listener for future events.
		const listener = line => res.write(line);
		job.listeners.push(listener);

		// Remove this listener when the response closes. Sol ruling 5: bind to
		// res.on('close'), not req.on('close'). On an SSE response the writable
		// side (res) is what tears down when the browser closes the EventSource
		// or the connection drops; req (the readable side) can already be ended on
		// a body-less GET, so a req-'close' handler could fire early or
		// unreliably. res-'close' fires exactly once when this response ends —
		// precisely when the listener must be detached. Issue W3.
		res.on('close', () => {
			const idx = job.listeners.indexOf(listener);
			if (idx >= 0) job.listeners.splice(idx, 1);
		});
	});

	// ─── DELETE /jobs/:jobId ─────────────────────────────────────────────────
	// Marks a job as cancelled so runPipeline exits cleanly between steps.
	// The pipeline reads isCancelled() after each step; when true it throws
	// CancelledError, which the catch block handles without emitting an error event.
	// Response: { ok: true }
	router.delete('/jobs/:jobId', (req, res) => {
		const job = jobs.get(req.params.jobId);
		if (!job) return res.status(404).json({ error: 'Job not found' });

		job.cancelled = true;
		// Emit the cancellation event so the SSE client can update the UI immediately
		// (the pipeline may still be mid-step and not see the flag yet).
		jobEmit(req.params.jobId, { type: 'cancelled', message: 'Job cancelled by user.' });
		res.json({ ok: true });
	});

	return router;
}

module.exports = createProcessRouter;
