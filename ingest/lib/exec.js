/**
 * exec.js — Safe child process helpers for the ingest pipeline
 *
 * Wraps Node's execFile (not exec!) so external binaries are called without
 * a shell. Arguments are passed as arrays directly to the OS — no quoting
 * needed, no injection risk. See the comment in server.js lines 29-33.
 *
 * Exports:
 *   run(cmd, args, opts)        — run a binary, return { stdout, stderr, error }. Never throws.
 *   runOrThrow(cmd, args, opts) — same as run, but throws on non-zero exit.
 */

'use strict';

// execFile: asynchronous binary execution. Does NOT invoke a shell, so
// arguments are never interpreted as shell syntax — eliminates shell injection.
const { execFile } = require('child_process');

/**
 * run — execute an external binary and return its output.
 *
 * @param {string} cmd  — path to the binary (e.g. 'vips', '/usr/local/bin/astap').
 *                         Resolved via PATH if not absolute.
 * @param {string[]} args — argument array. Passed directly to the OS, no shell involved.
 * @param {object} [opts] — optional: cwd, timeout, etc. forwarded to execFile.
 * @returns {Promise<{stdout: string, stderr: string, error: Error|null}>}
 *          Always resolves (never rejects). Check error field for failures.
 */
function run(cmd, args, opts = {}) {
	return new Promise(resolve => {
		execFile(cmd, args, { maxBuffer: 100 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
			resolve({ stdout: stdout || '', stderr: stderr || '', error: err });
		});
	});
}

/**
 * runOrThrow — execute an external binary, throw on non-zero exit.
 *
 * Same signature as run(). If the process exits with a non-zero status,
 * throws an Error containing stderr (or the error message if stderr is empty).
 * Returns stdout on success.
 *
 * @param {string} cmd  — path to the binary
 * @param {string[]} args — argument array
 * @param {object} [opts] — optional execFile options
 * @returns {Promise<string>} stdout on success
 * @throws {Error} with stderr content on non-zero exit
 */
async function runOrThrow(cmd, args, opts = {}) {
	const { stdout, stderr, error } = await run(cmd, args, opts);
	if (error) throw new Error(stderr || error.message);
	return stdout;
}

module.exports = { run, runOrThrow };
