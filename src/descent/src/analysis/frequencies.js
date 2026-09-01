// One-point (unigram) statistics on the symbol sequence: raw frequencies and the
// Zipf rank-frequency fit. These are the "one-point panel" of the explorable —
// the numbers that a SHUFFLE must NOT change, because shuffling permutes order
// but leaves per-symbol counts identical.

/**
 * Count how often each symbol occurs.
 * Receives: `seq`, an array of symbol strings.
 * Returns: a Map from symbol -> integer count.
 *
 * A Map (not a plain object) is used so symbols that happen to collide with
 * object-prototype names (e.g. "constructor") can't corrupt the counts.
 */
export function frequencies(seq) {
	const counts = new Map();
	for (const symbol of seq) {
		counts.set(symbol, (counts.get(symbol) || 0) + 1);
	}
	return counts;
}

/**
 * Zipf rank-frequency analysis.
 * Receives: `seq`, an array of symbol strings.
 * Returns: {
 *   ranked: [{ symbol, count, rank }]  symbols sorted by count descending, rank
 *                                       starting at 1 (ties still get distinct
 *                                       sequential ranks, the usual Zipf-plot
 *                                       convention);
 *   slope:  the least-squares slope of log10(count) vs log10(rank) across the
 *           ranked symbols. A Zipf-like distribution has slope near -1; a uniform
 *           distribution has slope 0 (flat line); slope is NEGATIVE for the
 *           heavy-head / long-tail shape.
 * }
 *
 * WHY least-squares on the log-log points: "Zipf slope" is conventionally the
 * gradient of the rank-frequency curve on log-log axes, and ordinary least
 * squares is the standard estimator of that gradient. We fit log10(count) as the
 * dependent variable against log10(rank) as the independent variable.
 *
 * Degenerate case: with fewer than 2 distinct symbols there is no variation in
 * rank, so the slope is genuinely undefined (0/0). We return NaN rather than a
 * fake 0 — reporting 0 would falsely assert "uniform Zipf" for a one-symbol
 * alphabet.
 */
export function zipf(seq) {
	const counts = frequencies(seq);

	// Sort symbols by descending count and attach 1-based ranks.
	const ranked = Array.from(counts.entries())
		.sort((a, b) => b[1] - a[1])
		.map(([symbol, count], i) => ({ symbol, count, rank: i + 1 }));

	if (ranked.length < 2) {
		return { ranked, slope: NaN };
	}

	// Ordinary least-squares slope of y = log10(count) on x = log10(rank).
	const xs = ranked.map((r) => Math.log10(r.rank));
	const ys = ranked.map((r) => Math.log10(r.count));
	const n = ranked.length;
	const meanX = xs.reduce((s, v) => s + v, 0) / n;
	const meanY = ys.reduce((s, v) => s + v, 0) / n;

	let numerator = 0; // Σ (x - x̄)(y - ȳ)
	let denominator = 0; // Σ (x - x̄)²
	for (let i = 0; i < n; i++) {
		const dx = xs[i] - meanX;
		numerator += dx * (ys[i] - meanY);
		denominator += dx * dx;
	}

	// denominator is 0 only if every rank is identical, which cannot happen once
	// ranked.length >= 2 (ranks are 1..n, all distinct) — so this is safe.
	const slope = numerator / denominator;
	return { ranked, slope };
}
