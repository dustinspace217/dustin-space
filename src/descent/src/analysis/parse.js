// Loading the CC-BY sperm-whale coda data into the symbol stream everything
// else consumes. Input shape is DominicaCodas.csv (Sharma et al. 2024): a header
// row plus one row per coda. The file ships with a UTF-8 BOM and CRLF line
// endings, both handled below.

// Columns this parser reads out of each row, by header NAME (not fixed index),
// so a future re-export of the CSV that reorders columns still parses correctly.
// `Date` is REQUIRED, not optional: without it there is no way to group codas into
// recording sessions, and the session-level null (shuffle within a day) is the rung
// of the null ladder that does the most work — 98.7% of adjacent rows share a
// recording day, so a null that ignores Date silently measures who-was-recorded-when
// instead of sequence structure. Dropping this column once already produced a
// phantom "within-date" result that was really a global shuffle.
const REQUIRED_HEADERS = ['Date', 'nClicks', 'Duration', 'CodaType', 'Clan', 'Unit', 'IDN'];

/**
 * Is this coda-type label a recording-quality artifact rather than a vocalization?
 * Receives: `codaType`, a label string from the CodaType column.
 * Returns: true for the `N-NOISE` family (e.g. "5-NOISE", "6-NOISE").
 *
 * The corpus labels ~6.9% of rows (600 of 8,719) as `<nClicks>-NOISE`. These mark
 * clicks the annotators could not resolve into a clean coda — they are measurement
 * artifacts, not sounds the whales "said". Left in, they inflate the alphabet from
 * 25 to 35 types and appear on a page as if they were part of the repertoire, which
 * a domain reader spots immediately. Callers decide whether to drop them; the parser
 * stays dumb and keeps every row, so the choice is visible at the call site.
 */
export function isNoiseLabel(codaType) {
	return /-NOISE$/i.test(codaType);
}

/**
 * Parse the DominicaCodas.csv text into structured coda records.
 * Receives: `csvText`, the full CSV file contents as a string.
 * Returns: an array of { nClicks, duration, ici, codaType, date, clan, unit, whaleId }.
 *   - nClicks  (int)    number of clicks in the coda.
 *   - duration (float)  coda duration in seconds (the `Duration` column).
 *   - ici      (float[]) inter-click intervals in seconds. The CSV pads ICI1..ICI9
 *                        with trailing zeros; a coda of nClicks clicks has exactly
 *                        nClicks-1 real intervals, so we keep the first nClicks-1
 *                        leading entries and drop the zero padding.
 *   - codaType (string) the symbolic coda label, e.g. "5R3" — THIS is the symbol
 *                        the information-theory pipeline operates on.
 *   - date     (string) recording day, verbatim "MM/DD/YYYY" — a session grouping key.
 *   - clan, unit (string) social-grouping labels. NOTE: the corpus holds TWO clans
 *                        (EC1 89.1%, EC2 10.9%), whose dialects differ — callers doing
 *                        sequence analysis should treat clan as a grouping variable,
 *                        not pool it away.
 *   - whaleId  (string) individual whale identity (the `IDN` column).
 *
 * WHY parse by header name: the header layout is `...,nClicks,Duration,ICI1..ICI9,
 * CodaType,Clan,Unit,UnitNum,IDN`. Indexing by name (rather than hard-coded
 * positions) means an added/reordered column upstream doesn't silently shift the
 * data we read — a real integrity risk for a science tool.
 */
export function parseCodas(csvText) {
	// Strip a leading UTF-8 BOM (U+FEFF) if present. The real file has one; left
	// in place it would corrupt the first header name (an invisible U+FEFF glued to
	// the front of "codaNUM2018" — described rather than pasted here, because a
	// literal BOM in the source is exactly the class of invisible character the
	// linter's no-irregular-whitespace rule exists to keep out).
	let text = csvText;
	if (text.charCodeAt(0) === 0xfeff) {
		text = text.slice(1);
	}

	// Split on CRLF or LF (the file is CRLF) and drop blank lines.
	const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
	if (lines.length === 0) {
		return [];
	}

	// Map each header name to its column index.
	const headers = lines[0].split(',').map((h) => h.trim());
	const idx = {};
	headers.forEach((h, i) => {
		idx[h] = i;
	});

	// Trust-boundary check (Power-of-Ten rule 5): a missing required column means
	// the input is not the schema we expect — fail loudly with context rather than
	// silently producing rows full of `undefined`.
	for (const required of REQUIRED_HEADERS) {
		if (!(required in idx)) {
			throw new Error(`parseCodas: missing required column "${required}" in header`);
		}
	}

	// Locate the ICI1..ICI9 columns once, in order.
	const iciCols = [];
	for (let k = 1; k <= 9; k++) {
		const name = `ICI${k}`;
		if (name in idx) {
			iciCols.push(idx[name]);
		}
	}

	const codas = [];
	// Bounded by the number of data lines — a naturally bounded loop over an
	// in-memory collection (Power-of-Ten rule 2 needs nothing extra here).
	for (let r = 1; r < lines.length; r++) {
		const fields = lines[r].split(',');
		const nClicks = parseInt(fields[idx.nClicks], 10);
		// Skip rows whose click count didn't parse — a normal-user-error guard for
		// a truncated/garbled line, consistent with the single-user localhost
		// ingest threat model (not adversarial hardening).
		if (!Number.isFinite(nClicks)) {
			continue;
		}

		// Guard against a row truncated AFTER nClicks but BEFORE CodaType: with fewer
		// fields than the header, fields[idx.CodaType] is `undefined`. It passes the
		// finite-nClicks check above, so without this guard an `undefined` (or an
		// empty "" from a `,,` gap) would be injected into the symbol stream and
		// poison every downstream count — it hashes to the literal key "undefined"/""
		// and manufactures a phantom coda type the whales never produced. A coda type
		// must be a non-empty string; skip the row otherwise. Same normal-user-error
		// posture as the nClicks guard (single-user localhost ingest threat model, not
		// adversarial hardening).
		const codaType = fields[idx.CodaType];
		if (typeof codaType !== 'string' || codaType.length === 0) {
			continue;
		}

		// Keep the first nClicks-1 ICI values (the real intervals); clamp to the 9
		// available columns and never go negative.
		const intervalCount = Math.max(0, Math.min(nClicks - 1, iciCols.length));
		const ici = [];
		for (let c = 0; c < intervalCount; c++) {
			ici.push(parseFloat(fields[iciCols[c]]));
		}

		codas.push({
			nClicks,
			duration: parseFloat(fields[idx.Duration]),
			ici,
			codaType,
			// Recording day, kept verbatim as the CSV's "MM/DD/YYYY" string. It is used
			// only as a session GROUPING KEY (string equality), never as a date value,
			// so no parsing/timezone handling is needed — and string equality is exactly
			// the right comparison for "were these two codas recorded the same day".
			date: fields[idx.Date],
			clan: fields[idx.Clan],
			unit: fields[idx.Unit],
			whaleId: fields[idx.IDN],
		});
	}

	return codas;
}

/**
 * Extract the symbol stream from parsed codas.
 * Receives: `codas`, the array returned by parseCodas.
 * Returns: an array of codaType strings in row order — the one-dimensional
 *          symbol sequence that entropy / MI / surrogate functions consume.
 */
export function symbolSequence(codas) {
	return codas.map((c) => c.codaType);
}
