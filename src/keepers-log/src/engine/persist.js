// persist.js — versioned save/load and the cross-playthrough archive, all
// through an injected storage adapter.
//
// The engine never touches localStorage directly (engine-spec ground rule
// "Pure"); it receives a StorageAdapter with getItem/setItem/removeItem. Tests
// pass a memory adapter, the browser passes a localStorage wrapper — the engine
// cannot tell them apart, which is the point.
//
// REFUSE, DON'T CORRUPT (engine-spec §7, extended after QA to the archive path):
// every read distinguishes empty / readable / unreadable-or-newer via a
// discriminated result; every JSON.parse is guarded; every write is guarded for
// quota. archiveEntries never rebuilds over a load it could not read — it
// refuses and leaves the bytes intact, so a save from a future build is
// recoverable rather than destroyed. The two stores stay under different keys so
// starting a new run can clear one without ever risking the other.

/**
 * @typedef {import('./types.js').GameState} GameState
 * @typedef {import('./types.js').Entry} Entry
 * @typedef {import('./types.js').StorageAdapter} StorageAdapter
 */

import { serialize, deserialize, isValidEntry } from './state.js';

// The current save-schema version. Bump only alongside a migration path.
export const SAVE_VERSION = 1;

// Storage keys. Namespaced so they never collide with anything else in a shared
// localStorage, and so the two stores are physically distinct.
export const SAVE_KEY = 'keepers-log/save';
export const ARCHIVE_KEY = 'keepers-log/archive';

// Hard cap on archived entries across ALL runs (QA SL-2/AT-5-archive). Without
// it the archive grows every playthrough until it trips MAX_ENTRIES on load and
// bricks every future run. The author accepts the honest loss: when the archive
// is full, the OLDEST run-blocks fall off the back of the book first — very old
// past runs eventually stop being inherited. That is a documented, graceful
// forgetting; an unbounded store is a slow-motion crash.
export const MAX_ARCHIVE_ENTRIES = 240;

/**
 * saveRun — write the current GameState to the in-run slot.
 * Receives: a StorageAdapter and a GameState.
 * Returns a result: { ok:true } or { ok:false, error:{ reason:'quota', detail } }.
 * The setItem is guarded (QA): localStorage.setItem throws on quota overflow, and
 *   an unguarded throw here would crash a save mid-play; the caller gets a clean
 *   result to surface instead.
 */
export function saveRun(adapter, state) {
	const envelope = { version: SAVE_VERSION, state: serialize(state) };
	try {
		adapter.setItem(SAVE_KEY, JSON.stringify(envelope));
		return { ok: true };
	} catch (e) {
		return { ok: false, error: { reason: 'quota', detail: e.message } };
	}
}

/**
 * LoadResult — the discriminated outcome of loadRun.
 * @typedef {Object} LoadResult
 * @property {boolean} ok
 * @property {GameState} [state]   Present when ok.
 * @property {Object} [error]      Present when !ok: { reason, ... }.
 */

/**
 * loadRun — read and validate the in-run save.
 * Receives: a StorageAdapter. Returns a LoadResult. The stored bytes are NEVER
 *   written by this function, so every failure path leaves them intact (no data
 *   loss — the whole point of refuse-don't-corrupt).
 *   - No save present         -> { ok:false, error:{ reason:'empty' } }.
 *   - Unparseable envelope     -> { ok:false, error:{ reason:'corrupt', ... } } (QA SL-3).
 *   - Unknown/newer version    -> { ok:false, error:{ reason:'unsupported-version', ... } }.
 *   - Parses but invalid state  -> { ok:false, error:{ reason:'invalid', ... } }.
 *   - Good                      -> { ok:true, state }.
 */
export function loadRun(adapter) {
	const raw = adapter.getItem(SAVE_KEY);
	if (raw == null) return { ok: false, error: { reason: 'empty' } };
	let envelope;
	try {
		envelope = JSON.parse(raw);
	} catch (e) {
		return { ok: false, error: { reason: 'corrupt', detail: e.message } };
	}
	if (envelope.version !== SAVE_VERSION) {
		return { ok: false, error: { reason: 'unsupported-version', foundVersion: envelope.version, expectedVersion: SAVE_VERSION } };
	}
	// deserialize now returns a discriminated result (guarded parse + validation).
	const result = deserialize(envelope.state);
	if (!result.ok) return { ok: false, error: result.error };
	return { ok: true, state: result.state };
}

/**
 * ArchiveResult — the discriminated outcome of loadArchive.
 * status distinguishes the four cases a caller must tell apart:
 *   'empty'   — nothing archived yet (a first-run player); ok:true, entries:[].
 *   'ok'      — readable; ok:true with runs/entries/runIds populated.
 *   'corrupt' — unparseable, wrong-shaped, or containing a malformed entry;
 *               ok:false. The bytes are left intact for recovery.
 *   'newer'   — written by a future build (version > ours); ok:false, foundVersion.
 * @typedef {Object} ArchiveResult
 * @property {boolean} ok
 * @property {'empty'|'ok'|'corrupt'|'newer'} status
 * @property {Array<{runId:string, entries:Entry[]}>} runs
 * @property {Entry[]} entries   Flattened across runs (the inherited log).
 * @property {string[]} runIds
 * @property {number} [foundVersion]
 */

/**
 * loadArchive — read the cross-playthrough archive as a discriminated result.
 * Receives: a StorageAdapter. Returns an ArchiveResult (see above).
 * Why discriminated, not a bare array (QA AT-4/AT-12): the previous version
 *   returned [] for empty, corrupt, AND newer alike — so archiveEntries could
 *   not tell "nothing here, safe to write" from "unreadable, must NOT clobber",
 *   and would happily overwrite a future-build archive. The caller now sees the
 *   difference and can refuse. Entry shapes are validated here so old/corrupt
 *   data fails at THIS boundary with a reason, not deep in the interlude.
 */
export function loadArchive(adapter) {
	const empty = { ok: true, status: 'empty', runs: [], entries: [], runIds: [] };
	const raw = adapter.getItem(ARCHIVE_KEY);
	if (raw == null) return empty;
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		return { ok: false, status: 'corrupt', runs: [], entries: [], runIds: [], detail: e.message };
	}
	if (typeof parsed.version === 'number' && parsed.version > SAVE_VERSION) {
		return { ok: false, status: 'newer', runs: [], entries: [], runIds: [], foundVersion: parsed.version };
	}
	if (parsed.version !== SAVE_VERSION || !Array.isArray(parsed.runs)) {
		return { ok: false, status: 'corrupt', runs: [], entries: [], runIds: [] };
	}
	// Validate the block shape and every entry within — one bad entry taints the
	// archive (refuse, don't silently drop, don't ingest garbage downstream).
	const entries = [];
	const runIds = [];
	for (const block of parsed.runs) {
		if (!block || typeof block.runId !== 'string' || !Array.isArray(block.entries)) {
			return { ok: false, status: 'corrupt', runs: [], entries: [], runIds: [] };
		}
		for (const entry of block.entries) {
			if (!isValidEntry(entry)) return { ok: false, status: 'corrupt', runs: [], entries: [], runIds: [] };
			entries.push(entry);
		}
		runIds.push(block.runId);
	}
	return { ok: true, status: 'ok', runs: parsed.runs, entries, runIds };
}

/**
 * archiveEntries — append one finished run's entries to the persistent archive.
 * Receives: a StorageAdapter, an array of Entry objects, and a stable runId.
 * Returns a result: { ok:true } | { ok:true, skipped:true } | { ok:false, error }.
 * Contract (QA AT-4/SL-4/SL-2):
 *   - REFUSES on an unreadable or newer archive (loadArchive !ok) — returns an
 *     error, writes NOTHING, so the existing bytes survive. It never rebuilds
 *     over a load it could not read.
 *   - IDEMPOTENT per run: archiving the same runId twice is a no-op skip, so a
 *     double-finish (a re-run of the epilogue) cannot duplicate the log.
 *   - CAPPED: after appending, trims whole oldest run-blocks until the total
 *     entry count is within MAX_ARCHIVE_ENTRIES (keeping at least the newest
 *     block, even if that block alone is large — losing the run just written
 *     would be worse than a slightly-over cap in that rare case).
 *   - GUARDED write: a quota failure returns an error result, never throws.
 * Also rejects malformed entries up front (invalid-entry) so garbage cannot be
 *   written and then poison the next loadArchive. Throws only on a missing runId
 *   — idempotency is meaningless without a stable id, so that is a programming
 *   error, not a runtime condition.
 */
export function archiveEntries(adapter, entries, runId) {
	if (typeof runId !== 'string' || !runId) throw new Error('archiveEntries: a stable runId is required');
	if (!Array.isArray(entries) || !entries.every(isValidEntry)) {
		return { ok: false, error: { reason: 'invalid-entry' } };
	}
	const current = loadArchive(adapter);
	if (!current.ok) return { ok: false, error: { reason: current.status } };
	if (current.runIds.includes(runId)) return { ok: true, skipped: true };

	let runs = [...current.runs, { runId, entries }];
	runs = trimToArchiveCap(runs);

	try {
		adapter.setItem(ARCHIVE_KEY, JSON.stringify({ version: SAVE_VERSION, runs }));
		return { ok: true };
	} catch (e) {
		return { ok: false, error: { reason: 'quota', detail: e.message } };
	}
}

/**
 * trimToArchiveCap — drop whole oldest run-blocks until within the entry cap.
 * Receives an array of run-blocks (oldest first); returns a possibly-shorter
 *   array. Trims from the FRONT (oldest runs fall off first) and always keeps at
 *   least one block. Bounded: each iteration removes one block, so it runs at
 *   most runs.length times.
 */
function trimToArchiveCap(runs) {
	let trimmed = runs;
	let total = countEntries(trimmed);
	while (total > MAX_ARCHIVE_ENTRIES && trimmed.length > 1) {
		trimmed = trimmed.slice(1);
		total = countEntries(trimmed);
	}
	return trimmed;
}

/**
 * countEntries — total entries across a list of run-blocks. Receives the blocks;
 * returns the summed length. Internal helper for the cap math.
 */
function countEntries(runs) {
	let n = 0;
	for (const block of runs) n += block.entries.length;
	return n;
}

/**
 * startNewRun — clear the in-run save while preserving the archive.
 * Receives: a StorageAdapter. Returns nothing. Removes ONLY the save key; the
 *   archive key is deliberately left in place so the new run inherits prior
 *   runs' entries. This asymmetry is the persistence thesis made literal.
 */
export function startNewRun(adapter) {
	adapter.removeItem(SAVE_KEY);
}

/**
 * memoryAdapter — an in-memory StorageAdapter for tests (and headless use).
 * Receives nothing; returns an object with the same three-method contract as
 *   localStorage, backed by a Map. Provided by the engine so tests never depend
 *   on a DOM or a real localStorage — the "run with a memory adapter" the ground
 *   rules call for.
 */
export function memoryAdapter() {
	const store = new Map();
	return {
		getItem: (key) => (store.has(key) ? store.get(key) : null),
		setItem: (key, value) => { store.set(key, String(value)); },
		removeItem: (key) => { store.delete(key); },
	};
}
