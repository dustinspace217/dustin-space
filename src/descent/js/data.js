// CORPUS LOADING — fetch the shipped CC-BY data file and hand the analysis core
// records in the shape it expects.
//
// The file at data/codas.json is built offline by scripts/build-data.js from the
// original CSV. It carries three things: the attribution block (a licence
// obligation, rendered into the page), the ordered symbol sequence, and one record
// per coda.

// Relative so the page works from any directory the dev server or host roots at.
const DATA_URL = 'data/codas.json';

/**
 * Translate one shipped coda record into the shape the analysis core reads.
 * Receives: a record from data/codas.json, using the short keys the build script
 *           writes: `t` coda type, `w` whale id, `d` recording day.
 * Returns: { codaType, whaleId, date } as src/analysis/ladder.js expects.
 *
 * WHY this adapter exists rather than either side simply renaming its fields:
 * the JSON uses one-letter keys because the field names repeat 8,719 times and the
 * short form is worth roughly a third of the file size a reader has to download.
 * The analysis core, which is unit tested and also runs offline against the raw CSV,
 * speaks the long descriptive names that make its own code readable. Neither choice
 * is wrong for its own side, so the translation happens once, here, at the boundary
 * between them. The alternative considered and rejected: teaching the analysis core
 * to accept both shapes, which would put a data-format concern inside the math and
 * mean every function had to guess which shape it was holding.
 *
 * Only the three fields the ladder actually reads are mapped. The other fields in
 * the record (inter-click intervals, clan, unit, noise flag) belong to later modules
 * and are deliberately left out so an unused field cannot quietly become load
 * bearing here. The ladder detects annotation noise from the coda type label itself,
 * so the record's `noise` boolean is not needed for this page.
 *
 * Exported (QA 2026-09-01, CR-1/TA-2) so tools/verify-page-numbers.mjs can run the
 * REAL adapter rather than a hand-copy of it — a copy that drifted would leave the
 * verify tool validating a pipeline the page no longer runs. This module stays
 * safe to import under node: everything above is declarations, and fetch is only
 * reached when loadCorpus() is actually called.
 */
export function toAnalysisRecord(record) {
	return {
		codaType: record.t,
		whaleId: record.w,
		date: record.d,
	};
}

/**
 * Pick real example codas for the listen strip, one per common coda type.
 * Receives: `records` (the raw shipped records, with their `ici` arrays) and
 *           `howMany` (number of distinct types wanted).
 * Returns: an array of { type, ici, count } — the type label, one real coda's
 *          inter-click gaps, and how many codas of that type the corpus holds.
 *
 * Selection is DETERMINISTIC — no randomness — so every visitor hears the same
 * examples and a bug report about one is reproducible: types are the most common
 * first, and the example for a type is its first record that is not annotation
 * noise, has at least two gaps (three clicks — one tick is not a rhythm), and has
 * no zero gap (a 0 entry means two clicks share a timestamp, which synthesizes as
 * one louder tick and misrepresents the pattern).
 *
 * WHY the most common types and not a curated set: the commonest types are the
 * ones the ladder's numbers are mostly made of, so they are the honest choice —
 * hand-picking the prettiest rhythms would be the page arguing with decoration.
 */
export function pickListenExamples(records, howMany) {
	const byType = new Map();
	for (const r of records) {
		if (!byType.has(r.t)) {
			byType.set(r.t, { count: 0, example: null });
		}
		const entry = byType.get(r.t);
		entry.count += 1;
		// Number.isFinite, not just > 0: a build-script regression emitting string
		// gaps would pass '0.29' > 0 by coercion, and codaTickTimes would then
		// string-concatenate its way to a NaN schedule (QA 2026-09-01 CR-5). The
		// could-happen-by-accident bar is exactly what this corpus's ingest is
		// held to.
		if (!entry.example && !r.noise && Array.isArray(r.ici)
			&& r.ici.length >= 2 && r.ici.every((gap) => Number.isFinite(gap) && gap > 0)) {
			entry.example = r.ici;
		}
	}
	return [...byType.entries()]
		.filter(([, v]) => v.example)
		.sort((a, b) => b[1].count - a[1].count)
		.slice(0, howMany)
		.map(([type, v]) => ({ type, ici: v.example, count: v.count }));
}

/**
 * Fetch and validate the coda corpus.
 * Receives: nothing (the URL is fixed above).
 * Returns: a promise for { attribution, codas, examples } where `codas` is ready
 *          for standardLadder(), `attribution` is the licence block verbatim, and
 *          `examples` is the listen strip's set from pickListenExamples().
 * Throws: an Error with a reader-facing message when the file cannot be fetched,
 *         cannot be parsed, or does not contain what this page needs.
 *
 * Validation is at a trust boundary, so it is explicit rather than assumed: a
 * truncated or half-built data file would otherwise reach the ladder and produce a
 * confident looking number computed from nothing. Every failure path here ends in a
 * thrown Error that main.js turns into a visible message, never a silent fallback.
 */
export async function loadCorpus() {
	let response;
	try {
		// Default caching, deliberately. An earlier draft forced `cache: 'no-store'`,
		// which re-downloaded the full corpus on every visit for no stated reason: the
		// file is immutable per deploy (a data correction ships as a new build), so a
		// stale copy cannot outlive the page that references it any longer than normal
		// HTTP caching allows. Re-fetching a megabyte per view to defend against a
		// staleness that cannot occur was cost without a threat (QA finding CR-4).
		response = await fetch(DATA_URL);
	} catch (cause) {
		// `cause` is attached as well as quoted: the message is for the reader on the
		// page, the cause chain is for whoever opens the console to debug it.
		throw new Error(`Could not reach the data file at ${DATA_URL}: ${cause.message}`, { cause });
	}
	if (!response.ok) {
		throw new Error(`The data file at ${DATA_URL} returned HTTP ${response.status}.`);
	}

	let payload;
	try {
		payload = await response.json();
	} catch (cause) {
		throw new Error(`The data file at ${DATA_URL} is not valid JSON: ${cause.message}`, { cause });
	}

	if (!payload || typeof payload !== 'object') {
		throw new Error('The data file did not contain a JSON object.');
	}
	if (!Array.isArray(payload.codas) || payload.codas.length === 0) {
		throw new Error('The data file contains no coda records.');
	}
	if (!payload.attribution || typeof payload.attribution !== 'object') {
		// The attribution block is a CC-BY obligation, not a nicety. Refusing to render
		// the page without it is the correct failure: publishing the derived numbers
		// while dropping the credit would breach the licence the data ships under.
		throw new Error('The data file is missing its attribution block, which this page is required to display.');
	}

	const codas = payload.codas.map(toAnalysisRecord);
	const firstIncomplete = codas.findIndex((c) => !c.codaType || !c.whaleId || !c.date);
	if (firstIncomplete !== -1) {
		throw new Error(`Coda record ${firstIncomplete} is missing its type, whale, or date.`);
	}

	// Three examples: enough to hear that types differ (the argument), few enough
	// that the strip stays one line and never competes with the staircase.
	return { attribution: payload.attribution, codas, examples: pickListenExamples(payload.codas, 3) };
}
