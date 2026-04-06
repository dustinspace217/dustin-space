/**
 * walk.js — Recursive directory walkers for the ingest pipeline
 *
 * Provides both a synchronous generator (walkDir) and an async generator
 * (walkDirAsync) that yield { local, rel } pairs for every file in a tree.
 *
 * Used primarily by the R2 upload module to enumerate DZI tile files.
 *
 * Exports:
 *   walkDir(dir, base)      — synchronous generator (uses readdirSync)
 *   walkDirAsync(dir, base) — async generator (uses fs.promises.readdir, non-blocking)
 */

'use strict';

const fs   = require('fs');
const fsp  = require('fs').promises;
const path = require('path');

/**
 * walkDir — walk a directory recursively, yielding {local, rel} pairs.
 *
 * Synchronous — uses readdirSync, which blocks the event loop briefly for each
 * directory. Fine for small trees; use walkDirAsync for large DZI tile sets.
 *
 * @param {string} dir  — absolute path to the directory to walk
 * @param {string} [base=''] — prefix for relative paths (used in recursion)
 * @yields {{ local: string, rel: string }}
 *   local = absolute path on disk
 *   rel   = path relative to the original dir argument
 */
function* walkDir(dir, base = '') {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const localPath = path.join(dir, entry.name);
		const relPath   = base ? `${base}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			yield* walkDir(localPath, relPath);
		} else {
			yield { local: localPath, rel: relPath };
		}
	}
}

/**
 * walkDirAsync — async version of walkDir. Uses fs.promises.readdir so it
 * doesn't block the event loop between directory reads. Yields the same
 * { local, rel } shape as walkDir.
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

module.exports = { walkDir, walkDirAsync };
