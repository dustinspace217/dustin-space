/**
 * walk.js — Recursive directory walker for the ingest pipeline
 *
 * Provides an async generator (walkDirAsync) that yields { local, rel } pairs
 * for every file in a tree.
 *
 * Used primarily by the R2 upload module to enumerate DZI tile files.
 *
 * Exports:
 *   walkDirAsync(dir, base) — async generator (uses fs.promises.readdir, non-blocking)
 */

'use strict';

const fsp  = require('fs').promises;
const path = require('path');

/**
 * walkDirAsync — walk a directory recursively, yielding {local, rel} pairs.
 * Uses fs.promises.readdir so it doesn't block the event loop between
 * directory reads.
 *
 * Usage:
 *   for await (const file of walkDirAsync('/some/path')) { ... }
 *
 * @param {string} dir  — absolute path to the directory to walk
 * @param {string} [base=''] — prefix for relative paths (used in recursion)
 * @yields {{ local: string, rel: string }}
 */
async function* walkDirAsync(dir, base = '') {
	// withFileTypes returns Dirent objects with isDirectory() method,
	// avoiding a separate stat call for each entry.
	const entries = await fsp.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const localPath = path.join(dir, entry.name);
		const relPath   = base ? `${base}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			// yield* doesn't work with async generators in all Node versions,
			// so we iterate explicitly.
			for await (const item of walkDirAsync(localPath, relPath)) {
				yield item;
			}
		} else {
			yield { local: localPath, rel: relPath };
		}
	}
}

module.exports = { walkDirAsync };
