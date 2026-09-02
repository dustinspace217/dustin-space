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
 * returns trigger(). Repeated triggers inside the window collapse to one fn
 * call after the last trigger. Why: NINA can emit several IMAGE-SAVE events
 * within a second (e.g. a sub plus its preview); one check() covers them all.
 *
 * The timer pair is injected rather than taken from the global scope so the
 * tests can assert WHICH handles were cleared without waiting real milliseconds.
 */
function createDebouncer(fn, ms, timers = { setTimeout, clearTimeout }) {
	let handle = null;
	return function trigger() {
		if (handle !== null) timers.clearTimeout(handle);
		handle = timers.setTimeout(() => { handle = null; fn(); }, ms);
	};
}

module.exports = { nextBackoffMs, createDebouncer };
