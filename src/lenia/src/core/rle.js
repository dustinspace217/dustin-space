// Decoder for Bert Chan's creature-cell encoding (animals.json format).
//
// Format (semantics verified against LeniaND.py ch2val/rle2arr — PLAN.md
// "Verified ground truth"):
//   '.' or 'b'      -> 0
//   'o'             -> 255
//   'A'..'X'        -> 1..24
//   '<p..y><A..X>'  -> (c0-'p')*24 + (c1-'A') + 25   (so 'pA'=25 .. 'yO'=255)
//   leading digits  -> run count for the NEXT token (value or '$')
//   '$'             -> row break
//   trailing '!'    -> terminator, ignored
// Values are stored as val/255 so the decoded field lives in [0,1] like the
// rest of the engine.
//
// Receives: the raw cells string from animals.json / data/creatures.json.
// Returns: { w, h, data } — row-major Float64Array(w*h); ragged rows are
// zero-padded to the widest row (matches the reference implementation's
// behavior of treating missing trailing cells as empty).
export function decodeCells(str) {
	const rows = [];
	let row = [];
	let count = '';       // pending digit run, as string ('' = no run = 1)
	let prefix = '';      // pending p..y prefix awaiting its A..X letter

	// Push `val` onto the current row `n` times.
	const push = (val, n) => { for (let i = 0; i < n; i++) row.push(val); };

	const s = str.replace(/!+$/, '');
	for (const ch of s) {
		// Whitespace is fully transparent: source files wrap long RLE strings
		// across lines, and a break can land between a run-count's digits and
		// its token, or between a p..y prefix and its A..X letter. Skip it at
		// the TOP of the loop so `count` and `prefix` survive untouched. (The
		// old code handled whitespace mid-loop, AFTER consuming `count` into
		// `n` and clearing `prefix` — so a wrapped token silently lost both;
		// the "restore it" comment described an intent the code never carried out.)
		if (ch === '\n' || ch === ' ' || ch === '\r' || ch === '\t') continue;
		if (ch >= '0' && ch <= '9') { count += ch; continue; }
		if (ch >= 'p' && ch <= 'y') { prefix = ch; continue; }
		const n = count === '' ? 1 : parseInt(count, 10);
		count = '';
		// Cap the run count. Corrupt or hand-edited data could carry an absurd
		// count (or overflow parseInt to a huge finite value / Infinity) and
		// push() would then try to build a multi-billion-element row, hanging
		// the tab or OOMing it. 10000 is three orders of magnitude above any
		// real creature row, so a legitimate string never trips it. Guards both
		// the value-run push below and the '$'-row-run path.
		if (!Number.isFinite(n) || n > 10000) {
			throw new Error(`rle: run count ${n} exceeds maximum`);
		}
		if (ch === '$') {
			// Row break — a run count means several breaks, i.e. n-1 empty
			// rows between content rows.
			rows.push(row); row = [];
			for (let i = 1; i < n; i++) { rows.push([]); }
		} else if (ch === '.' || ch === 'b') {
			push(0, n);
		} else if (ch === 'o') {
			push(1, n);
		} else if (ch >= 'A' && ch <= 'X') {
			const val = prefix === ''
				? (ch.charCodeAt(0) - 64)                                          // A..X -> 1..24
				: (prefix.charCodeAt(0) - 112) * 24 + (ch.charCodeAt(0) - 65) + 25; // pA.. -> 25..
			// Clamp at the ingestion boundary: the two-char tokens yP..yX encode
			// 256..264, which as val/255 exceed 1.0 and would push the field out
			// of the engine's [0,1] domain. Clamp to 1.0 so a stray high token
			// can't poison a decoded creature.
			push(Math.min(1, val / 255), n);
		} else {
			throw new Error(`rle: unexpected character '${ch}'`);
		}
		prefix = '';
	}
	if (row.length) rows.push(row);

	const h = rows.length;
	let w = 0;
	for (const r of rows) w = Math.max(w, r.length);
	if (w === 0 || h === 0) throw new Error('rle: decoded to empty grid');
	const data = new Float64Array(w * h);
	for (let y = 0; y < h; y++) {
		const r = rows[y];
		for (let x = 0; x < r.length; x++) data[y * w + x] = r[x];
	}
	return { w, h, data };
}
