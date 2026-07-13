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
 *   recordTombstone(id, job) — remember a finished job's terminal event on removal
 *   getTombstone(id)         — retrieve a removed job's terminal event line
 */

'use strict';

// ─── in-memory job store ──────────────────────────────────────────────────────
// Each job has a list of buffered SSE events and live emitter functions.
// Buffering lets a reconnected client catch up on events it missed.
const jobs = new Map();

// ─── tombstones for expired jobs ──────────────────────────────────────────────
// When a finished job is removed from `jobs` (30-min GC in routes/process.js), a
// client that reconnects afterward would otherwise get a bare 404 it can't
// interpret — did the job fail, or never exist? A tombstone keeps just the
// terminal SSE line (the 'done' event) so a late reconnect still receives a
// proper terminal event and the UI settles instead of hanging. Bounded so the
// map can't grow without limit across many ingest runs. Power-of-Ten rule 3.
const tombstones = new Map();
const MAX_TOMBSTONES = 200;

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

	// Pin the two structurally-important lines so the replay-buffer cap can never
	// evict them:
	//   - init   drives the progress bar (totalSteps). A reconnecting client that
	//     replays the buffer with no init line has a broken/empty progress bar.
	//   - done   is the terminal event and becomes the tombstone on GC.
	// Both are captured here regardless of buffer churn. Issue W3.
	if (event.type === 'init') job.initLine = line;
	if (event.type === 'done') job.terminalLine = line;

	job.events.push(line);
	// Bound the replay buffer so a job that emits many events (e.g. a large DZI
	// producing hundreds of "R2 upload: X/Y" progress lines) can't grow events[]
	// without limit. The buffer exists only to replay history to a client that
	// reconnects mid-job; the SSE replay (routes/process.js) forEach-writes the
	// whole array with no Last-Event-ID/offset reader, so dropping the oldest
	// lines is safe — a reconnecting client just won't see the earliest history.
	// Power-of-Ten rule 3 (bound memory growth).
	const MAX_EVENTS = 500;
	if (job.events.length > MAX_EVENTS) {
		job.events.splice(0, job.events.length - MAX_EVENTS);
		// Re-pin the init event at the front. init is emitted very early — after
		// the leading `step` events, so not literally the first line — which puts
		// it among the OLDEST lines, so it's among the first the splice above drops
		// once a job exceeds MAX_EVENTS. Without re-pinning, a reconnecting client
		// on a large job replays 500 progress lines but never the totalSteps init
		// that makes them mean anything. Keeps events[] at most MAX_EVENTS+1. Issue W3.
		if (job.initLine && job.events[0] !== job.initLine) {
			job.events.unshift(job.initLine);
		}
	}
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

/**
 * recordTombstone — remember a finished job's terminal event as it's removed
 * from the live `jobs` map, so a later reconnect gets a real terminal event
 * instead of a 404.
 *
 * @param {string} jobId — the job being garbage-collected
 * @param {object} job   — the job object; its terminalLine (captured by jobEmit
 *   when the 'done' event fired) is stored. If the job somehow has no terminal
 *   line (never reached 'done'), a synthetic `expired` line is stored so the
 *   client still settles.
 *
 * Why `type: 'expired'` (not a synthetic `done`) for the no-terminal case: the
 * client's SSE handler (public/js/pipeline.js) renders a `done` event with a
 * null slug and no cancelled flag as "Finished with errors" — wrong for a job
 * that simply outlived the 30-min GC window without ever terminating. It has a
 * dedicated `expired` branch that shows "Job expired" and stops the reconnect
 * loop; emitting `expired` here routes the synthetic case to it. A REAL
 * terminalLine (a genuine `done`/cancel/error) is passed through unchanged, so
 * only the never-terminated fallback uses `expired`.
 */
function recordTombstone(jobId, job) {
	const line = (job && job.terminalLine)
		|| `data: ${JSON.stringify({ type: 'expired', slug: null, expired: true })}\n\n`;
	tombstones.set(jobId, line);
	// Evict the oldest tombstone when over the cap. Map preserves insertion
	// order, so the first key is the oldest. Bounds memory. Power-of-Ten rule 3.
	if (tombstones.size > MAX_TOMBSTONES) {
		const oldest = tombstones.keys().next().value;
		tombstones.delete(oldest);
	}
}

/**
 * getTombstone — return the stored terminal SSE line for a removed job, or
 * undefined if this job was never tombstoned.
 *
 * @param {string} jobId — the job to look up
 * @returns {string|undefined} the terminal SSE line, ready to res.write()
 */
function getTombstone(jobId) {
	return tombstones.get(jobId);
}

module.exports = {
	jobs,
	withImagesMutex,
	jobEmit,
	isCancelled,
	CancelledError,
	recordTombstone,
	getTombstone,
};
