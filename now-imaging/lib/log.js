/**
 * log.js — append-only text log with one-file rotation.
 * Dustin's observability preference: every publish and every state change is
 * a line an admin can read; the file is bounded (rotate at maxBytes, keep one
 * predecessor) so a year of nights can't fill the MeLe's disk.
 */
'use strict';
const fs = require('node:fs');

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
		(level === 'INFO' ? process.stdout : process.stderr).write(line);
	}

	return {
		info:  (m) => write('INFO', m),
		warn:  (m) => write('WARN', m),
		error: (m) => write('ERROR', m),
	};
}

module.exports = { createLogger };
