/**
 * resolve.js — turn NINA's freeform target string into the two names the card
 * shows: a colloquial name and ONE catalog designation (spec §5.4).
 *
 * Order: overrides.json → disk cache → Simbad TAP. Simbad failure never blocks
 * publishing: the card then shows the raw name with no designation.
 *
 * Simbad's `ident` table matches freeform forms ("Veil Nebula", "NGC 6960")
 * directly — verified 2026-09-01 with the exact query below. Identifiers come
 * back with internal padding ("NGC  6960"); we collapse whitespace on output.
 */
'use strict';

const fs = require('node:fs');

const SIMBAD_TAP = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync';

// Catalog priority for the ONE designation shown — the owner's astro-library
// naming convention (recorded 2026-05-27 in the project's memory store; not in
// this repo): Messier > NGC > IC > Sharpless > Barnard > LBN/LDN > vdB > Arp >
// HCG > Abell > UGC/MCG/ESO/PGC. Each regex is tested against a
// whitespace-normalized identifier. Order is the priority.
// Caldwell is absent from Simbad's ident table, so Caldwell targets resolve to
// their NGC/IC designation; use overrides.json when the Caldwell number is wanted.
const CATALOG_PRIORITY = [
	/^M \d+$/i, /^NGC \d+[A-Z]?$/i, /^IC \d+[A-Z]?$/i, /^SH 2-\d+$/i, /^Barnard \d+$/i,
	/^LBN \d+$/i, /^LDN \d+$/i, /^VdB \d+$/i, /^APG \d+$/i, /^Arp \d+$/i, /^HCG \d+$/i, /^ACO \d+$/i,
	/^UGC \d+$/i, /^MCG[ +-]/i, /^ESO \d+-\d+$/i, /^LEDA \d+$/i,
];

/**
 * normalizeKey — canonical form for matching names: lowercase, single spaces, trimmed.
 * Receives a string; returns a string.
 */
function normalizeKey(s) {
	return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** tidy — collapse Simbad's internal padding ("NGC  6960" → "NGC 6960"). */
function tidy(s) {
	return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * pickFromIds — PURE choice of {name, designation} from a Simbad ids list.
 * Receives the raw NINA name, Simbad's main_id, and the pipe-joined ids string.
 * Returns {name, designation}.
 *
 * name: if the raw string IS one of the "NAME …" aliases, use that alias with
 * Simbad's casing (so "veil nebula" → "Veil Nebula"); otherwise the first NAME
 * alias in Simbad's list (their order is not curated — "Cirrus Nebula" precedes
 * "Veil Nebula" — which is exactly what overrides.json is for); otherwise the
 * designation itself.
 * designation: first identifier matching CATALOG_PRIORITY, in priority order;
 * else main_id.
 */
function pickFromIds(rawName, mainId, idsPipe) {
	const ids = String(idsPipe || '').split('|').map(tidy).filter(Boolean);
	const names = ids.filter(id => /^NAME /i.test(id)).map(id => id.replace(/^NAME /i, ''));
	const rawKey = normalizeKey(rawName);

	let designation = null;
	for (const re of CATALOG_PRIORITY) {                   // bounded: fixed list
		const hit = ids.find(id => re.test(id));
		if (hit) { designation = hit; break; }
	}
	if (!designation) designation = tidy(mainId) || null;

	let name = names.find(n => normalizeKey(n) === rawKey) || names[0] || designation;
	return { name, designation };
}

/**
 * createResolver — factory holding overrides + cache + network.
 * Receives: overrides (object from overrides.json), cachePath (file, may not
 * exist yet), fetchImpl (defaults to global fetch; tests inject a fake),
 * timeoutMs (Simbad timeout, default 8000).
 * Returns { resolve(rawName) }.
 */
function createResolver({ overrides = {}, cachePath, fetchImpl = fetch, timeoutMs = 8000 }) {
	// Overrides keyed by normalized name; keys starting with "_" are comments.
	// Both maps are built with Object.create(null) because resolve() looks names
	// up with bare `over[key]` / `cache[key]`. On a normal object those lookups
	// also reach Object.prototype, so a target literally named "constructor"
	// would resolve to the Object constructor and never reach Simbad. A
	// prototype-less map makes every non-entry a plain miss; the alternative,
	// an Object.hasOwn guard at each of the two call sites, puts the burden on
	// every future lookup instead of on the map.
	const over = Object.create(null);
	for (const [k, v] of Object.entries(overrides)) if (!k.startsWith('_')) over[normalizeKey(k)] = v;

	// The cache file is only trusted when it parses to a plain object. A file
	// holding a scalar or an array — truncated, hand-edited, or written by an
	// older format — would otherwise throw on every resolve(): `null` throws on
	// the `cache[key]` read, a string on the `cache[key] = picked` write. Either
	// way the never-rejects contract breaks. Discarding the file costs one round
	// of re-querying and nothing else.
	//
	// Size (Power of Ten rule 3): one entry per DISTINCT target name ever imaged,
	// and no TTL by design. There is no eviction because the bound is the number
	// of targets Dustin shoots, not the number of frames — a few dozen lines of
	// JSON over the life of the rig — and because a Simbad designation for a
	// fixed name does not go stale. Deleting the file is the only refresh, and it
	// is safe: it rebuilds on demand (see the README).
	const cache = Object.create(null);
	try {
		const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(cache, parsed);
	} catch {
		// No cache file yet, or it is unreadable/not JSON: start empty.
	}

	/**
	 * saveCache — write the in-memory cache map back to cachePath as JSON.
	 * Receives nothing (closes over `cache` and `cachePath`); returns nothing.
	 * A write failure is warned and swallowed: the name is already resolved, so
	 * the only cost is one extra Simbad query on a later run.
	 */
	function saveCache() {
		try { fs.writeFileSync(cachePath, JSON.stringify(cache, null, '\t')); }
		catch (err) { console.warn('[resolve] cache write failed:', err.message); }   // non-fatal by design
	}

	/**
	 * querySimbad — one TAP round-trip. Receives the raw name; returns
	 * [main_id, ids] or null on any failure (HTTP, timeout, empty, malformed).
	 * ADQL string literal: single quotes are escaped by doubling.
	 */
	async function querySimbad(rawName) {
		const lit = String(rawName).replace(/'/g, "''");
		const adql = `SELECT b.main_id, i.ids FROM basic b JOIN ids i ON i.oidref=b.oid JOIN ident d ON d.oidref=b.oid WHERE d.id='${lit}'`;
		const url = new URL(SIMBAD_TAP);
		url.searchParams.set('request', 'doQuery');
		url.searchParams.set('lang', 'adql');
		url.searchParams.set('format', 'json');
		url.searchParams.set('query', adql);
		try {
			const resp = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(timeoutMs) });
			if (!resp.ok) return null;
			const body = await resp.json();
			const row = body && Array.isArray(body.data) && body.data[0];
			return row && row.length >= 2 ? [String(row[0]), String(row[1])] : null;
		} catch {
			// Nothing is logged at this layer: resolve() turns null into the
			// raw-name fallback below, which is what keeps publishing going.
			return null;
		}
	}

	/**
	 * resolve — the public entry. Receives NINA's raw target name; returns
	 * Promise<{name, designation}>. Never rejects.
	 */
	async function resolve(rawName) {
		const key = normalizeKey(rawName);
		if (!key) return { name: String(rawName || ''), designation: null };
		// Both hit paths hand back a fresh object, so a caller that mutates the
		// result cannot reach into `over` or `cache`: the override branch
		// already builds a new literal, and the cache branch spreads its entry.
		if (over[key]) return { name: String(over[key].name || rawName), designation: over[key].designation || null };
		if (cache[key]) return { ...cache[key] };
		const row = await querySimbad(rawName);
		if (!row) return { name: String(rawName), designation: null };   // deliberately NOT cached: retry next target
		const picked = pickFromIds(rawName, row[0], row[1]);
		cache[key] = picked;
		saveCache();
		return { ...picked };   // copy for the same reason the cache branch spreads
	}

	return { resolve };
}

module.exports = { createResolver, pickFromIds, normalizeKey, CATALOG_PRIORITY };
