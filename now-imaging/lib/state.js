/**
 * state.js — the agent's tiny persistent memory (state.json beside config).
 * {lastFilename, lastKey, pendingDelete[]}: which NINA file was last published,
 * which R2 key holds it, and any old keys whose delete failed and must be retried.
 * Survives agent restarts: this file only PERSISTS the three values — it is
 * agent.js comparing lastFilename that turns them into "don't re-publish the
 * frame we already published", and the publisher's prevKey/pendingDelete that
 * turn them into "don't orphan the frame we replaced".
 */
'use strict';
const fs = require('node:fs');

const DEFAULTS = () => ({ lastFilename: null, lastKey: null, pendingDelete: [] });

/**
 * createState — receives the state file path; returns {load, save}.
 * load(): parsed state merged over defaults, with pendingDelete filtered to
 * strings (see below). A missing file and a CORRUPT one
 * both yield defaults, and load() does not distinguish them — the caller gets
 * no signal it could log. That is deliberate for the missing-file case (first
 * run) and a known limitation for the corrupt case: a damaged state.json
 * silently forgets lastKey, which orphans one JPEG in R2 and re-publishes the
 * current frame once. Both are self-correcting on the next frame, so the
 * simpler signature was kept over a load() that reports why.
 * save(obj): writes to a temp file and renames, so a CRASHED PROCESS cannot
 * leave a half-written state.json that the next start would read as corrupt.
 * rename(2) is atomic within a filesystem; there is no fsync, so this defends
 * against a dying process rather than against a power loss. Assumes one agent
 * instance — two would race on the same `.tmp` path.
 */
function createState(filePath) {
	function load() {
		try {
			const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
			return Object.assign(DEFAULTS(), {
				lastFilename: parsed.lastFilename ?? null,
				lastKey: parsed.lastKey ?? null,
				// Strings only. These values are handed back as R2 object keys, and a
				// non-string reaches the publisher's key check only as a coercion of
				// itself ({} becomes "[object Object]") — never a key that can be
				// deleted. A hand-edited file is the realistic source.
				pendingDelete: Array.isArray(parsed.pendingDelete)
					? parsed.pendingDelete.filter(k => typeof k === 'string')
					: [],
			});
		} catch {
			return DEFAULTS();
		}
	}
	function save(obj) {
		const tmp = `${filePath}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(obj, null, '\t'));
		fs.renameSync(tmp, filePath);
	}
	return { load, save };
}

module.exports = { createState };
