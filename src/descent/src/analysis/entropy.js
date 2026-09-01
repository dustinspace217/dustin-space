// Entropy estimators — the heart of the "how much structure is really there?"
// question, and the part most prone to a silent integrity failure. Two estimates
// are exposed side by side on purpose: the naive plug-in (Shannon) estimator,
// which is DOWNWARD biased on finite samples, and the Miller-Madow correction,
// which adds a positive term to counteract that bias. A reader (and a skeptical
// peer) can compare them; a UI that showed only one would hide the bias.

import { frequencies } from './frequencies.js';

// Composite-key separator: control char U+0001, which does not occur in this
// corpus's coda-type labels or the test symbols (a property of THIS input, not a
// guaranteed-impossible byte). Built via fromCharCode so no raw control byte lives
// in source. Joining block symbols with it (rather than "") stops distinct
// multi-character blocks from colliding, e.g. ["5R","3"] vs ["5","R3"].
const SEP = String.fromCharCode(1);

/**
 * Normalize the `counts` argument to a flat array of numeric counts.
 * Receives: `counts`, either an array of integers or a Map symbol->count.
 * Returns: an array of the count values.
 */
function countValues(counts) {
	if (counts instanceof Map) {
		return Array.from(counts.values());
	}
	if (Array.isArray(counts)) {
		return counts;
	}
	// Fall back to treating it as any iterable of count values.
	return Array.from(counts);
}

/**
 * Plug-in (naive / maximum-likelihood) Shannon entropy, in BITS.
 * Receives: `counts`, an array or Map of non-negative integer counts.
 * Returns: H = -Σ p_i log2 p_i, where p_i = count_i / N and N = Σ counts.
 *
 * This is the biased baseline estimator. On finite samples it UNDERESTIMATES the
 * true entropy (it never "sees" unobserved symbols and over-weights the ones it
 * did see), which is exactly why millerMadowEntropy exists below. Zero counts
 * contribute nothing (0·log0 is taken as 0, the standard convention).
 */
export function shannonEntropy(counts) {
	const values = countValues(counts);
	let total = 0;
	for (const c of values) {
		total += c;
	}
	if (total === 0) {
		return 0;
	}

	let entropy = 0;
	for (const c of values) {
		if (c > 0) {
			const p = c / total;
			entropy -= p * Math.log2(p);
		}
	}
	return entropy;
}

/**
 * Miller-Madow bias-corrected entropy, in BITS.
 * Receives: `counts`, an array or Map of non-negative integer counts.
 * Returns: shannonEntropy(counts) + (K - 1) / (2N · ln2),
 *          where K = number of observed types (count > 0) and N = Σ counts.
 *
 * WHY the (K-1)/(2N·ln2) term: the plug-in estimator is negatively biased, and
 * to first order that bias is -(K-1)/(2N) NATS. Miller-Madow simply adds back an
 * estimate of that bias. The division by ln2 (Math.LN2) converts the correction
 * from nats to bits so it lines up with our bits-valued Shannon term. The
 * correction is POSITIVE and shrinks as N grows (more data → less bias to
 * correct), so MM ≥ plug-in always, with equality only when K = 1.
 *
 * Note this is a first-order correction, not exact: it does not fully remove the
 * bias for severely undersampled distributions (where NSB/Grassberger do better),
 * but it is cheap, transparent, and always moves in the right direction.
 */
export function millerMadowEntropy(counts) {
	const values = countValues(counts);
	let total = 0;
	let observedTypes = 0;
	for (const c of values) {
		total += c;
		if (c > 0) {
			observedTypes += 1;
		}
	}
	if (total === 0) {
		return 0;
	}
	const plugin = shannonEntropy(values);
	return plugin + (observedTypes - 1) / (2 * total * Math.LN2);
}

/**
 * Normalized Shannon entropy of the unigram distribution, in [0, 1].
 * Receives: `seq`, an array of symbol strings.
 * Returns: H(unigram) / log2(alphabetSize) — Kershenbaum (2021)'s robust
 *          estimator, which stands in for the Zipf coefficient without the
 *          fragility of a log-log slope fit. 0 means one symbol dominates; 1
 *          means a perfectly uniform alphabet.
 *
 * Guard: with an alphabet of size 1, log2(1) = 0 and the ratio is 0/0. We return
 * 0 in that case — a single-symbol stream carries no uncertainty.
 *
 * Uses the PLUG-IN Shannon entropy (not Miller-Madow) deliberately: this is a
 * normalized descriptive statistic of the observed distribution, and Kershenbaum's
 * estimator is defined on the plug-in entropy.
 */
export function normalizedEntropy(seq) {
	const counts = frequencies(seq);
	const alphabetSize = counts.size;
	if (alphabetSize <= 1) {
		return 0;
	}
	return shannonEntropy(counts) / Math.log2(alphabetSize);
}

/**
 * Count contiguous length-n blocks (n-grams) of a sequence.
 * Receives: `seq` (symbol array) and `n` (block length, integer >= 1).
 * Returns: a Map from block-key -> count. The key joins the n symbols with the
 *          U+0001 separator so distinct blocks never collide.
 *
 * There are seq.length - n + 1 blocks (sliding window, step 1).
 */
function countBlocks(seq, n) {
	const counts = new Map();
	if (n <= 0) {
		return counts;
	}
	const numBlocks = seq.length - n + 1;
	for (let i = 0; i < numBlocks; i++) {
		const key = seq.slice(i, i + n).join(SEP);
		counts.set(key, (counts.get(key) || 0) + 1);
	}
	return counts;
}

/**
 * Miller-Madow-corrected block entropy H_block(n), in BITS.
 * Receives: `seq` (symbol array) and `n` (block length).
 * Returns: the MM entropy of the distribution of length-n contiguous blocks.
 *          By convention H_block(0) = 0 (there is exactly one empty block).
 *
 * Block entropies are the ingredients of the conditional entropy below. They are
 * MM-corrected because longer blocks are sampled far more thinly than single
 * symbols, so their plug-in bias is larger and correcting it matters more.
 */
export function blockEntropy(seq, n) {
	if (n <= 0) {
		return 0;
	}
	return millerMadowEntropy(countBlocks(seq, n));
}

/**
 * Conditional (block) entropy h(n): the average uncertainty of the next symbol
 * GIVEN the n symbols before it, in BITS.
 * Receives: `seq` (symbol array) and `n` (number of predecessors to condition on,
 *           integer >= 1).
 * Returns: {
 *   value:          h(n) = H_block(n+1) - H_block(n);
 *   distinctBlocks: number of distinct (n+1)-blocks actually observed;
 *   totalBlocks:    total number of (n+1)-blocks (seq.length - n);
 *   undersampled:   true when EITHER of two criteria fires (see below) — the
 *                   honest "too few samples per block to trust this" flag.
 * }
 *
 * WHY value = H_block(n+1) - H_block(n) rather than H_block(n) - H_block(n-1):
 * `n` here is the number of PREDECESSORS conditioned on. Conditioning on n
 * predecessors uses the joint distribution of (n+1)-symbol blocks, so the chain
 * rule gives H(next | n predecessors) = H_block(n+1) - H_block(n). Concretely
 * conditionalEntropy(seq, 1) is "entropy of the next symbol given ONE predecessor"
 * = H_block(2) - H_block(1) = the order-1 entropy rate. (This differs by one index
 * from the alternate academic convention h(n) = H_block(n) - H_block(n-1), which
 * would make h(1) the unconditional single-symbol entropy. We use the
 * predecessors-conditioned indexing so that h(1) is the quantity that goes to 0
 * for a fully predictable sequence and equals the entropy rate for a Markov chain
 * — matching the known-answer tests.)
 *
 * WHY the undersampled flag reads the (n+1)-block level: the estimate's
 * reliability is limited by how thinly the LONGEST blocks it uses are sampled. Two
 * INDEPENDENT criteria are OR'd together, because the project's bias is to
 * OVER-flag — a false "insufficient data" costs a hidden number, a false
 * "trustworthy" manufactures structure, and only the latter corrupts the science:
 *   (1) UNIQUENESS — more than half of the observed (n+1)-blocks are distinct
 *       (distinctBlocks / totalBlocks > 0.5). Fires when the samples are spread
 *       thinly across MANY keys (the near-all-unique case).
 *   (2) COVERAGE  — the block table is starved relative to the block SPACE it
 *       must populate: totalBlocks < 5 · alphabetSize^(n+1), where alphabetSize is
 *       the number of distinct symbols in `seq`. Fires when a CONCENTRATED-but-thin
 *       distribution (few distinct keys, each thinly sampled) keeps the uniqueness
 *       ratio low yet still has far too few blocks per possible key to trust. This
 *       is exactly the case (1) misses on its own.
 */
export function conditionalEntropy(seq, n) {
	// Build the (n+1)-block table ONCE and reuse it for BOTH the entropy value and
	// the sampling statistics below. Previously countBlocks(seq, n+1) was computed
	// twice — once inside blockEntropy(seq, n+1), once here for `.size` — which for
	// a long sequence is a wasted full pass. millerMadowEntropy(blocksNext) is
	// exactly blockEntropy(seq, n+1) (n+1 >= 2 > 0 here, so the n<=0 guard is moot).
	const blocksNext = countBlocks(seq, n + 1);
	const value = millerMadowEntropy(blocksNext) - blockEntropy(seq, n);

	// Sampling statistics of the (n+1)-block distribution, which the estimate rests on.
	const level = n + 1;
	const totalBlocks = Math.max(0, seq.length - level + 1);
	const distinctBlocks = blocksNext.size;
	const alphabetSize = new Set(seq).size;

	// Criterion (1) uniqueness and (2) coverage — see the docstring. Empty input has
	// totalBlocks === 0, which both criteria treat as undersampled (nothing to trust).
	const uniqueness = totalBlocks > 0 ? distinctBlocks / totalBlocks > 0.5 : true;
	const coverage = totalBlocks < 5 * alphabetSize ** (n + 1);
	const undersampled = uniqueness || coverage;

	return { value, distinctBlocks, totalBlocks, undersampled };
}
