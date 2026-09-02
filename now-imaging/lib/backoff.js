/**
 * backoff.js — PURE timing helpers used by agent.js. Timers are injectable so
 * the tests never sleep.
 */
'use strict';

/**
 * nextBackoffMs — exponential reconnect delay: base·2^attempt, ±20% jitter,
 * capped. Receives the attempt number (0-based) and options; returns ms.
 * Jitter keeps a fleet of reconnects from synchronizing (one rig here, but the
 * habit is free); the cap keeps "NINA is closed for the day" at one attempt per
 * minute, not one per hour.
 *
 * The inner Math.min on `attempt` bounds the exponent before it is used, so a
 * long outage cannot push 2^attempt to Infinity — the outer Math.min would then
 * be comparing against Infinity forever, which happens to give the right answer
 * today but only by accident. Clamping the exponent keeps the arithmetic finite.
 */
function nextBackoffMs(attempt, { baseMs = 1000, capMs = 60000, random = Math.random } = {}) {
	const exp = Math.min(capMs, baseMs * Math.pow(2, Math.min(attempt, 30)));
	const jitter = 0.8 + 0.4 * random();                   // 0.8 … 1.2
	return Math.min(capMs, Math.round(exp * jitter));
}

/**
 * createDebouncer — receives fn, a window in ms, and an optional timer pair;
 * returns trigger(), which also carries trigger.cancel(). Repeated triggers
 * inside the window collapse to one fn call after the last trigger. Why: NINA
 * can emit several IMAGE-SAVE events within a second (e.g. a sub plus its
 * preview); one check() covers them all.
 *
 * The timer pair is injected rather than taken from the global scope so the
 * tests can assert WHICH handles were cleared without waiting real milliseconds.
 */
function createDebouncer(fn, ms, timers = { setTimeout, clearTimeout }) {
	let handle = null;

	function trigger() {
		if (handle !== null) timers.clearTimeout(handle);
		handle = timers.setTimeout(() => { handle = null; fn(); }, ms);
	}

	/**
	 * cancel — drop a pending call without running it. Receives nothing (closes
	 * over `handle`); returns nothing. Idempotent: cancelling with nothing pending
	 * does nothing. Exists so a shutting-down caller can stop a fn it no longer
	 * wants — a pending debounce also holds Node's event loop open, so without
	 * this the process lingers for the length of the window after stop().
	 */
	trigger.cancel = function cancel() {
		if (handle === null) return;
		timers.clearTimeout(handle);
		handle = null;
	};

	return trigger;
}

// How long a socket must stay open before the connection counts as healthy and
// the reconnect ladder resets. Without this floor, a NINA that accepts the
// connection and drops it immediately resets `attempt` on every 'open' and the
// agent reconnects roughly once a second forever instead of backing off.
const STABLE_SOCKET_MS = 60000;

/**
 * createReconnector — the "stay connected to NINA" policy, extracted from
 * agent.js so it can be exercised without a socket or a real clock.
 *
 * Receives {connect, log, timers, backoff, now, stableMs}: `connect` opens ONE
 * socket (the caller wires its own state callback to `onState` below), `log` is
 * the agent logger, and the rest are injection points the agent leaves at their
 * defaults. Returns {start, onState, stop}.
 *
 * Why EITHER event schedules the retry, rather than 'closed' alone. Measured on
 * Node 22.22.2 (2026-09-01), three teardown shapes, each watched 45 s:
 *   - connection refused (nothing listening): 'error' at ~30 ms and nothing
 *     else. No 'close' ever arrives and readyState stays CONNECTING (0).
 *   - accepted, then the TCP socket destroyed before the upgrade completes:
 *     'error' at ~39 ms, likewise no 'close'.
 *   - an ESTABLISHED socket torn down (abrupt destroy or a clean FIN):
 *     'open' then 'close' (code 1006), and no 'error'.
 * So the event that says "NINA is not listening" is 'error', and reconnecting
 * from 'closed' alone stops retrying at exactly the moment retrying matters —
 * NINA exits for the day, the one scheduled retry is refused, and nothing
 * schedules another.
 *
 * `reconnectScheduled` then bounds it to ONE retry per open() call. Note what
 * that guard is and is not: no measured shape emitted both events, so this is a
 * guard against a pairing this probe did not produce (another WebSocket
 * implementation, or a teardown shape not covered above), not a workaround for
 * an observed one. Its scope is the open() call rather than the socket object,
 * which is the same thing only because a socket that has already failed was
 * never seen to emit anything afterwards — over 45 s, in the two failure shapes
 * above. A late event from an abandoned socket would land against the next
 * instance's flag and arm a second reconnect; that is the residual risk here.
 */
function createReconnector({
	connect,
	log,
	timers = { setTimeout, clearTimeout },
	backoff = nextBackoffMs,
	now = Date.now,
	stableMs = STABLE_SOCKET_MS,
}) {
	let attempt = 0;               // rung on the backoff ladder; reset by a stable open
	let openedAt = 0;              // now() at the last 'open', or 0 if this socket never opened
	let stopped = false;           // one-way: set by stop(), never cleared
	let reconnectScheduled = false; // one retry per open() call — see the header comment
	let timer = null;

	/**
	 * open — start one socket and mark it as a fresh instance. Receives nothing,
	 * returns nothing. Called by start() and by the reconnect timer, so the
	 * `stopped` gate here covers a timer that fires during shutdown.
	 */
	function open() {
		if (stopped) return;
		reconnectScheduled = false;
		timer = null;
		connect();
	}

	/**
	 * scheduleReconnect — arm the next attempt for a socket that has failed.
	 * Receives the state name that triggered it (logged, so an operator can tell a
	 * refusal from a drop); returns nothing.
	 */
	function scheduleReconnect(state) {
		if (stopped || reconnectScheduled) return;
		reconnectScheduled = true;
		// The reset is gated on openedAt !== 0 rather than left to the subtraction:
		// `now() - 0` reads as "open since the epoch", which would clear the ladder
		// for a socket that never opened at all — the refused case, every time.
		if (openedAt !== 0 && now() - openedAt >= stableMs) attempt = 0;
		openedAt = 0;
		const wait = backoff(attempt++);
		// One line per socket failure, naming the state so an operator can tell a
		// refusal ('error' — NINA is not listening) from a drop ('closed' — it was
		// and stopped). A close at the end of a session is routine; an error is not,
		// hence the level split. The suppressed second event of a pair logs nothing
		// on purpose: it is the same failure, already reported.
		const line = `socket ${state}; reconnecting in ${wait} ms`;
		if (state === 'error') log.warn(line); else log.info(line);
		timer = timers.setTimeout(open, wait);
	}

	return {
		/** start — open the first socket. Receives nothing; returns nothing. */
		start: open,

		/**
		 * onState — feed one socket state in. Receives 'open' | 'closed' | 'error'
		 * (nina.openSocket's vocabulary); returns nothing. Unknown states are
		 * ignored rather than treated as failures.
		 */
		onState(state) {
			if (state === 'open') {
				// Opening is not by itself proof of health — the ladder resets on the
				// way OUT, and only for a socket that lasted. All that happens here is
				// recording when it opened.
				openedAt = now();
				log.info('socket open, subscribed to IMAGE-SAVE');
				return;
			}
			if (state === 'error' || state === 'closed') scheduleReconnect(state);
		},

		/**
		 * stop — shut the policy down. Receives nothing; returns nothing. Clears any
		 * armed reconnect (a pending one holds Node's event loop open for its whole
		 * wait) and latches `stopped`, because closing the live socket brings
		 * onState back one last time with 'closed'.
		 */
		stop() {
			stopped = true;
			if (timer !== null) { timers.clearTimeout(timer); timer = null; }
		},
	};
}

module.exports = { nextBackoffMs, createDebouncer, createReconnector, STABLE_SOCKET_MS };
