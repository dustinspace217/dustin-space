'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { createReconnector, nextBackoffMs, STABLE_SOCKET_MS } = require('../../now-imaging/lib/backoff');

/**
 * fakeTimers — a stand-in for the global setTimeout/clearTimeout pair.
 * Receives nothing; returns {timers, setTimeout, clearTimeout} where `timers` is
 * the array of everything ever armed ({fn, ms, cleared}). Handles are 1-based
 * indexes into it, so a test can both count the reconnects that were scheduled
 * and fire one by hand — no test in this file waits a real millisecond.
 */
function fakeTimers() {
	const timers = [];
	return {
		timers,
		setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
		clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
	};
}

/**
 * fakeLog — collects log lines instead of writing them.
 * Receives nothing; returns {lines, info, warn, error} where `lines` holds
 * `LEVEL message` strings in order. The reconnector must name the state that
 * triggered a reconnect, so the lines are assertions, not decoration.
 */
function fakeLog() {
	const lines = [];
	return {
		lines,
		info:  (m) => lines.push(`INFO ${m}`),
		warn:  (m) => lines.push(`WARN ${m}`),
		error: (m) => lines.push(`ERROR ${m}`),
	};
}

// Jitter pinned to its midpoint (0.8 + 0.4·0.5 = 1.0) so the waits are exactly
// base·2^attempt and the tests can assert them as numbers.
const noJitter = (attempt) => nextBackoffMs(attempt, { random: () => 0.5 });

test("createReconnector: 'error' alone schedules exactly one reconnect", () => {
	// The case this whole helper exists for. Measured on Node 22.22.2 (2026-09-01):
	// a WebSocket to a closed port emits 'error' at ~30 ms and no 'close' in the
	// 45 s watched, so a policy that only reconnects from 'closed' stops retrying
	// at the moment NINA shuts down and never picks the socket back up.
	const timers = fakeTimers();
	const log = fakeLog();
	let opens = 0;
	const r = createReconnector({ connect: () => { opens++; }, log, timers, backoff: noJitter });

	r.start();
	assert.equal(opens, 1, 'start() opens the first socket');

	r.onState('error');
	assert.equal(timers.timers.length, 1, "'error' scheduled a reconnect");
	assert.equal(timers.timers[0].ms, 1000, 'first retry waits one base interval');
	// One line, naming the state, at a level an operator will see: a refused
	// connection is not routine the way an end-of-session close is.
	assert.ok(log.lines.includes('WARN socket error; reconnecting in 1000 ms'),
		`the log names the state that triggered it — got ${JSON.stringify(log.lines)}`);

	timers.timers[0].fn();
	assert.equal(opens, 2, 'the timer re-opened the socket');
});

test("createReconnector: 'error' then 'closed' on one socket schedules exactly one", () => {
	// No teardown shape probed on Node 22 actually emitted both events (see the
	// header of createReconnector for the three measured), so this pins the guard
	// rather than an observed pairing: if some other WebSocket implementation does
	// deliver both, one failure must still open one socket, not two — two would
	// double the reconnect rate on every cycle afterwards. Pinned in both arrival
	// orders because nothing establishes which would come first.
	const timers = fakeTimers();
	let opens = 0;
	const r = createReconnector({ connect: () => { opens++; }, log: fakeLog(), timers, backoff: noJitter });
	r.start();

	r.onState('error');
	r.onState('closed');
	assert.equal(timers.timers.length, 1, 'the second event was absorbed');

	// And the same holds in the other arrival order, on the NEXT instance.
	timers.timers[0].fn();
	assert.equal(opens, 2);
	r.onState('closed');
	r.onState('error');
	assert.equal(timers.timers.length, 2, 'one schedule for the second socket too');
});

test('createReconnector: after stop() neither event schedules anything', () => {
	const timers = fakeTimers();
	let opens = 0;
	const r = createReconnector({ connect: () => { opens++; }, log: fakeLog(), timers, backoff: noJitter });
	r.start();

	// A reconnect already armed must be cleared, or the process lingers for its
	// whole wait — stop() is what the agent's own stop() calls.
	r.onState('error');
	r.stop();
	assert.ok(timers.timers[0].cleared, 'stop() cleared the pending reconnect');

	// close() on the live socket brings the handler back one last time; the
	// shutdown must not answer it with a new connection.
	r.onState('closed');
	r.onState('error');
	assert.equal(timers.timers.length, 1, 'no reconnect scheduled after stop()');

	// Even if a cleared timer somehow fires (a real clearTimeout race), connect()
	// must not run again.
	timers.timers[0].fn();
	assert.equal(opens, 1, 'connect() was not re-entered after stop()');
});

test('createReconnector: backoff grows across flaps and resets after a stable open', () => {
	// Round 1's rule, kept: only a socket that PROVED itself by staying up resets
	// the ladder. A NINA that accepts and drops immediately must back off like an
	// absent one rather than spinning at one reconnect per second all night.
	const timers = fakeTimers();
	let clock = 1_000_000;
	const r = createReconnector({
		connect: () => {}, log: fakeLog(), timers, backoff: noJitter,
		now: () => clock, stableMs: STABLE_SOCKET_MS,
	});
	r.start();

	for (let i = 0; i < 3; i++) {                 // three instant flaps
		r.onState('open');
		clock += 500;                             // nowhere near the stable floor
		r.onState('closed');
		timers.timers[timers.timers.length - 1].fn();
	}
	assert.deepEqual(timers.timers.map((t) => t.ms), [1000, 2000, 4000], 'the ladder climbed');

	r.onState('open');
	clock += STABLE_SOCKET_MS;                    // this one earned its reset
	r.onState('closed');
	assert.equal(timers.timers[3].ms, 1000, 'a stable socket reset the ladder');

	// A socket that never opened must not be read as "open since the epoch".
	timers.timers[3].fn();
	clock += 90000;
	r.onState('error');
	assert.equal(timers.timers[4].ms, 2000, 'no reset for a socket that never opened');
});
