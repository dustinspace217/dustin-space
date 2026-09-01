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

// Catalog priority for the ONE designation shown — the library naming
// convention (2026-05-27): Messier > Caldwell > NGC > IC > Sharpless > Barnard >
// LBN/LDN > vdB > Arp > HCG > Abell > UGC/MCG/ESO/PGC. Each regex is tested
// against a whitespace-normalized identifier. Order is the priority.
const CATALOG_PRIORITY = [
	/^M \d+$/i, /^C \d+$/i, /^NGC \d+[A-Z]?$/i, /^IC \d+[A-Z]?$/i, /^SH 2-\d+$/i, /^Barnard \d+$/i,
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
	const over = {};
	for (const [k, v] of Object.entries(overrides)) if (!k.startsWith('_')) over[normalizeKey(k)] = v;

	let cache = {};
	try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { cache = {}; }

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
		if (over[key]) return { name: String(over[key].name || rawName), designation: over[key].designation || null };
		if (cache[key]) return cache[key];
		const row = await querySimbad(rawName);
		if (!row) return { name: String(rawName), designation: null };   // deliberately NOT cached: retry next target
		const picked = pickFromIds(rawName, row[0], row[1]);
		cache[key] = picked;
		saveCache();
		return picked;
	}

	return { resolve };
}

module.exports = { createResolver, pickFromIds, normalizeKey, CATALOG_PRIORITY };
