/**
 * jobs.js — In-memory job store and SSE event system for the ingest pipeline
 *
 * Manages the lifecycle of pipeline jobs: creation, event buffering for SSE
 * replay, cancellation signaling, and a mutex for serializing images.json writes.
 *
 * The jobs Map is the central state store. Each entry tracks:
 *   events[]    — buffered SSE lines for replay on client reconnect
 *   listeners[] — live callback functions (one per connected EventSource)
 *   status      — 'running' | 'done'
 *   cancelled   — boolean, set by DELETE /api/jobs/:jobId
 *
 * Exports:
 *   jobs             — the Map instance (keyed by jobId UUID strings)
 *   jobEmit(id, evt) — serialize and push an SSE event to all listeners
 *   isCancelled(id)  — check whether a job has been cancelled
 *   CancelledError   — error class thrown when cancellation is detected mid-step
 *   withImagesMutex  — serialize async read-modify-write operations on images.json
 */

'use strict';

// ─── in-memory job store ──────────────────────────────────────────────────────
// Each job has a list of buffered SSE events and live emitter functions.
// Buffering lets a reconnected client catch up on events it missed.
const jobs = new Map();

// ─── mutex for images.json read-modify-write ──────────────────────────────────
// Node.js is single-threaded but async — two concurrent ingest runs can both
// reach the read-modify-write at the same time. This serialises those operations
// so neither run silently clobbers the other's entry.
let imagesMutex = Promise.resolve();

/**
 * withImagesMutex — serialize an async function so concurrent callers run
 * one at a time. Used to protect images.json read-modify-write sequences.
 *
 * @param {function} fn — async function to run exclusively
 * @returns {Promise} resolves/rejects with fn's result
 *
 * Even if fn throws, the catch() swallows the rejection so the chain
 * keeps moving for future callers — but p still rejects for our caller.
 */
function withImagesMutex(fn) {
	const p = imagesMutex.then(() => fn());
	// The catch here keeps the mutex chain alive after a rejection — without it,
	// future callers would never execute. We log the error so it isn't silently
	// swallowed, while still returning p (which rejects) to the caller.
	imagesMutex = p.catch(err => {
		console.error('[mutex] images.json operation failed:', err.message);
	});
	return p;
}

/**
 * jobEmit — emit an SSE event to all listeners for a job.
 *
 * @param {string} jobId — UUID string returned when the job was created
 * @param {object} event — plain object with a type field that controls
 *   how the browser renders the line:
 *   { type: 'step'|'ok'|'warn'|'progress'|'error'|'done', message?, slug? }
 *
 * The event is serialized with JSON.stringify and wrapped in the SSE
 * "data:" prefix format. Two trailing newlines end the event per the SSE spec.
 */
function jobEmit(jobId, event) {
	const job = jobs.get(jobId);
	if (!job) return;
	const line = `data: ${JSON.stringify(event)}\n\n`;
	job.events.push(line);
	job.listeners.forEach(fn => fn(line));
}

/**
 * isCancelled — check whether a job has been cancelled.
 *
 * @param {string} jobId — UUID string of the job to check
 * @returns {boolean} true if the job's cancelled flag was set by
 *   DELETE /api/jobs/:jobId, false if still running or doesn't exist
 */
function isCancelled(jobId) {
	return jobs.get(jobId)?.cancelled ?? false;
}

/**
 * CancelledError — thrown inside runPipeline when cancellation is detected.
 * The catch block checks instanceof CancelledError to distinguish a user-
 * initiated stop from an unexpected pipeline failure.
 */
class CancelledError extends Error {
	constructor() {
		super('Job cancelled by user.');
		this.name = 'CancelledError';
	}
}

module.exports = {
	jobs,
	withImagesMutex,
	jobEmit,
	isCancelled,
	CancelledError,
};
