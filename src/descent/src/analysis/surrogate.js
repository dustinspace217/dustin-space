// Null-model generators. These produce sequences that share SOME structure with
// the whale codas but not the structure under test, so every measured number can
// be shown against "what you'd see by chance." shuffle destroys all order (keeps
// one-point frequencies); markovSurrogate keeps short-range transition structure
// (an order-n Markov null).

// Composite-key separator: control char U+0001, which does not occur in this
// corpus's coda-type labels or the test symbols (a property of THIS input, not a
// guaranteed-impossible byte). Built via fromCharCode so no raw control byte lives
// in source. Joining a multi-symbol Markov context with it (rather than "") stops
// distinct contexts from colliding at order >= 2, e.g. ["5R","3"] vs ["5","R3"].
const SEP = String.fromCharCode(1);

/**
 * Sample one symbol from a count distribution using an injected rng.
 * Receives: `distribution` (Map symbol->count) and `rng` (function -> [0,1)).
 * Returns: a symbol, chosen with probability proportional to its count.
 *
 * Standard inverse-CDF sampling: draw r in [0, total), walk the counts
 * subtracting until r goes negative. The final `return` is a floating-point
 * safety net for the r-just-below-total edge; it never changes the distribution.
 */
function sampleFromCounts(distribution, rng) {
	let total = 0;
	for (const c of distribution.values()) {
		total += c;
	}
	let r = rng() * total;
	let last;
	for (const [symbol, c] of distribution) {
		last = symbol;
		r -= c;
		if (r < 0) {
			return symbol;
		}
	}
	return last;
}

/**
 * Fisher-Yates shuffle of a sequence, using an injected rng.
 * Receives: `seq` (symbol array) and `rng` (function -> [0,1), defaults to
 *           Math.random). Tests always pass a seeded rng for reproducibility.
 * Returns: a NEW shuffled array. The input is copied first, never mutated.
 *
 * WHY it must not mutate: callers (e.g. the MI shuffled-baseline) shuffle the
 * same source sequence many times; mutating it would corrupt every later draw.
 * Fisher-Yates is the unbiased shuffle — each permutation is equally likely when
 * the rng is uniform.
 */
export function shuffle(seq, rng = Math.random) {
	const out = seq.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = out[i];
		out[i] = out[j];
		out[j] = tmp;
	}
	return out;
}

/**
 * Generate a Markov surrogate: a NEW sequence, same length as `seq`, sampled from
 * the empirical order-`order` transition distribution of `seq`.
 * Receives:
 *   - `seq`   the source symbol sequence to imitate;
 *   - `order` the Markov order. 0 = i.i.d. draws from the unigram frequencies;
 *             1 = draws from the observed bigram (first-order) transitions; and so on.
 *   - `rng`   injected [0,1) generator (defaults to Math.random; tests seed it).
 * Returns: an array of symbols of the same length as `seq`.
 *
 * The first `order` symbols are SEEDED from `seq` (we need a context of length
 * `order` before the chain can start generating). Each subsequent symbol is drawn
 * from the distribution of symbols that historically followed the current
 * order-length context in `seq`.
 *
 * WHY a unigram fallback for unseen contexts: a generated path can wander into a
 * context that appeared in `seq` only at its very end (with no following symbol
 * recorded), so that context has no transition row. Rather than dead-end, we fall
 * back to the unigram distribution — a rare, documented degradation that keeps the
 * surrogate the promised length without inventing transitions.
 */
export function markovSurrogate(seq, order, rng = Math.random) {
	const length = seq.length;
	const safeOrder = Math.max(0, order);

	// Too short to build any context of the requested order — return a copy.
	if (length <= safeOrder) {
		return seq.slice();
	}

	// Unigram counts, used directly for order 0 and as the unseen-context fallback.
	const unigram = new Map();
	for (const symbol of seq) {
		unigram.set(symbol, (unigram.get(symbol) || 0) + 1);
	}

	// Build the transition table: context-key -> Map(nextSymbol -> count).
	// For order 0 there is a single empty context whose distribution is the unigram.
	const table = new Map();
	if (safeOrder === 0) {
		table.set('', unigram);
	} else {
		for (let i = safeOrder; i < length; i++) {
			const context = seq.slice(i - safeOrder, i).join(SEP);
			const next = seq[i];
			if (!table.has(context)) {
				table.set(context, new Map());
			}
			const row = table.get(context);
			row.set(next, (row.get(next) || 0) + 1);
		}
	}

	// Seed the first `order` symbols verbatim, then generate the rest.
	const out = seq.slice(0, safeOrder);
	for (let i = safeOrder; i < length; i++) {
		const context = safeOrder === 0 ? '' : out.slice(i - safeOrder, i).join(SEP);
		const distribution = table.get(context) || unigram;
		out.push(sampleFromCounts(distribution, rng));
	}
	return out;
}
