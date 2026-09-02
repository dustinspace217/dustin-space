/**
 * log.js — append-only text log with one-file rotation.
 * Dustin's observability preference: every publish and every state change is
 * a line an admin can read; the file is bounded (rotate at maxBytes, keep one
 * predecessor) so a year of nights can't fill the MeLe's disk.
 */
'use strict';
const fs = require('node:fs');

// Set once the no-op stream error listeners below are installed. Module-level,
// not per-logger, so N loggers in one process do not stack N listeners and trip
// Node's MaxListenersExceededWarning at ten.
let streamErrorsMuted = false;

/**
 * muteStreamErrors — attach a no-op 'error' listener to stdout and stderr.
 * Receives nothing; returns nothing. Idempotent.
 *
 * Why this and not a try/catch around the write: a write to a closed pipe fails
 * ASYNCHRONOUSLY. Measured on Node 22 (2026-09-01) by writing to a pipe whose
 * reader had exited: `.write()` did not throw, and the EPIPE arrived at
 * uncaughtException — so a try/catch around the call never sees it and the
 * process dies over a lost log line, which is the opposite of this module's
 * contract. The same probe with this no-op listener attached survived 200
 * writes. The listener does nothing on purpose: the console mirror is a
 * convenience, the file is the record.
 */
function muteStreamErrors() {
	if (streamErrorsMuted) return;
	streamErrorsMuted = true;
	process.stdout.on('error', () => {});
	process.stderr.on('error', () => {});
}

/**
 * createLogger — receives the log file path and {maxBytes} (default 5 MB);
 * returns {info, warn, error}, each taking a message string. Lines are
 * `<ISO time> <LEVEL> <message>`. Also mirrors to stdout/stderr so the
 * Scheduled Task's console (if any) and `npm start` show the same stream.
 *
 * Nothing here throws. A logger that can fail takes the agent down for a full
 * disk or a locked file, and the agent's whole contract is that it keeps
 * running; a lost log line is the cheaper failure, and the console mirror below
 * still carries it.
 */
function createLogger(filePath, { maxBytes = 5 * 1024 * 1024 } = {}) {
	muteStreamErrors();

	/**
	 * rotateIfNeeded — rename the live file to `<path>.1` once it reaches
	 * maxBytes. Receives nothing (closes over filePath/maxBytes); returns nothing.
	 * Only ONE predecessor is kept: renaming over an existing `.1` discards the
	 * older one, which bounds the pair at 2·maxBytes without a numbered-archive
	 * scheme nobody would read.
	 */
	function rotateIfNeeded() {
		try {
			if (fs.existsSync(filePath) && fs.statSync(filePath).size >= maxBytes) fs.renameSync(filePath, `${filePath}.1`);
		} catch { /* rotation is best-effort; logging must never throw */ }
	}

	/**
	 * write — one log line. Receives the level string and the message; returns
	 * nothing. The size check runs BEFORE the append, so the live file can
	 * overshoot maxBytes by at most the length of one line — cheaper than
	 * stat-ing again afterwards, and the bound is on disk use, not on exactness.
	 */
	function write(level, msg) {
		const line = `${new Date().toISOString()} ${level} ${msg}\n`;
		rotateIfNeeded();
		try { fs.appendFileSync(filePath, line); } catch { /* disk trouble: still print below */ }
		// muteStreamErrors above is what actually handles the failure this mirror can
		// hit (an async EPIPE — measured, see there). This try/catch is belt-and-braces
		// for a SYNCHRONOUS throw: probed on Node 22 against a destroyed stream and it
		// did NOT throw, so no trigger for it is known today. Kept anyway because the
		// contract above is "nothing here throws" unconditionally, and one line is a
		// cheap way to not owe that promise to a stream implementation's internals.
		try { (level === 'INFO' ? process.stdout : process.stderr).write(line); } catch { /* console gone; the file has it */ }
	}

	return {
		info:  (m) => write('INFO', m),
		warn:  (m) => write('WARN', m),
		error: (m) => write('ERROR', m),
	};
}

module.exports = { createLogger };
