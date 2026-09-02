'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');
const { createDebouncer, nextBackoffMs } = require('../../now-imaging/lib/backoff');
const { createLogger } = require('../../now-imaging/lib/log');

test('nextBackoffMs: doubles from base, jittered ±20%, capped', () => {
	const r = () => 0.5;                                    // jitter midpoint → exact doubling
	assert.equal(nextBackoffMs(0, { random: r }), 1000);
	assert.equal(nextBackoffMs(1, { random: r }), 2000);
	assert.equal(nextBackoffMs(5, { random: r }), 32000);
	assert.equal(nextBackoffMs(20, { random: r }), 60000);
	const lo = nextBackoffMs(2, { random: () => 0 }), hi = nextBackoffMs(2, { random: () => 1 });
	assert.equal(lo, 3200); assert.equal(hi, 4800);
});

test('createDebouncer: a burst of triggers collapses to one call after the window', () => {
	const timers = [];
	const fake = { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (id) => { timers[id - 1].cleared = true; } };
	let calls = 0;
	const trigger = createDebouncer(() => calls++, 2000, fake);
	trigger(); trigger(); trigger();
	assert.equal(timers.length, 3);
	assert.ok(timers[0].cleared && timers[1].cleared && !timers[2].cleared);
	timers[2].fn();
	assert.equal(calls, 1);
});

test('createDebouncer: cancel() drops a pending call and is idempotent', () => {
	// stop() calls this. Without it a debounce armed by a last-moment IMAGE-SAVE
	// still fires a check after shutdown, and holds the event loop open meanwhile.
	const timers = [];
	const fake = { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (id) => { timers[id - 1].cleared = true; } };
	let calls = 0;
	const trigger = createDebouncer(() => calls++, 2000, fake);

	trigger();
	trigger.cancel();
	assert.ok(timers[0].cleared, 'the pending timer was cleared');

	// Nothing pending: a second cancel must not clear a handle it no longer owns.
	trigger.cancel();
	assert.equal(timers.length, 1, 'cancel() arms no timer of its own');

	// And the debouncer still works afterwards — cancel() is not a one-way latch.
	trigger();
	assert.equal(timers.length, 2);
	timers[1].fn();
	assert.equal(calls, 1);
});

test('createLogger: appends timestamped lines and rotates once over maxBytes', () => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'log-')), 'a.log');
	const log = createLogger(file, { maxBytes: 200 });
	for (let i = 0; i < 20; i++) log.info(`line ${i} ${'x'.repeat(20)}`);
	assert.ok(fs.existsSync(`${file}.1`), 'rotated file exists');
	assert.ok(fs.statSync(file).size <= 400, 'live file stays small after rotation');
	assert.match(fs.readFileSync(file, 'utf8'), /^\d{4}-\d{2}-\d{2}T[^ ]+ INFO line/m);
});

test('createLogger: mutes stream errors once per process, not once per logger', () => {
	// An EPIPE on a detached stdout arrives as an asynchronous 'error' event, which
	// Node escalates to an uncaught exception when nothing listens — killing the
	// agent over a lost log line. The listener is installed at module level so ten
	// loggers do not stack ten listeners and trip MaxListenersExceededWarning.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-mute-'));
	const before = process.stdout.listenerCount('error');
	for (let i = 0; i < 5; i++) createLogger(path.join(dir, `${i}.log`));
	const after = process.stdout.listenerCount('error');
	assert.ok(after >= 1, 'stdout has an error listener');
	assert.ok(process.stderr.listenerCount('error') >= 1, 'stderr has an error listener');
	// At most one added in total, however many loggers were built. (`before` is
	// already 1 when an earlier test in this file constructed a logger first.)
	assert.ok(after <= before + 1, `expected at most one added listener, went ${before} -> ${after}`);
});
