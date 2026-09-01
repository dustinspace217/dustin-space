// Two-point structure: mutual-information decay I(d) as a function of the distance
// d between two symbols. This is the "two-point panel" — the structure the
// one-point frequency panel is blind to, and the thing a SHUFFLE collapses.
//
// The honest-nulls design turns on this file: raw MI is POSITIVELY biased at low
// counts (it manufactures apparent structure), so we subtract a shuffled baseline
// (Sainburg's Î − Î_shuffled) and flag the data-starved tail. A spurious
// power-law tail — MI that looks like long-range structure but is really just
// sampling noise — is the main failure mode this correction guards against.

import { shuffle } from './surrogate.js';

// Composite-key separator: control char U+0001, which does not occur in this
// corpus's coda-type labels or any test symbol (a property of THIS input, not a
// guaranteed-impossible byte). Built via fromCharCode so no raw control byte lives
// in the source. Using it (rather than empty-string concatenation) stops distinct
// multi-character symbols from colliding, e.g. "5R"+"3" vs "5"+"R3".
const SEP = String.fromCharCode(1);

/**
 * Raw plug-in mutual information between symbols d apart, in BITS.
 * Receives: `seq` (symbol array) and `d` (distance >= 1).
 * Returns: I(d) = Σ_{a,b} P(a,b) log2[ P(a,b) / (P(a)·P(b)) ], estimated over all
 *          adjacent-at-distance-d pairs (seq[i], seq[i+d]).
 *
 * The marginals P(a) and P(b) are taken from the PAIR SET itself: P(a) from the
 * first positions of the pairs, P(b) from the second positions. This is the
 * standard MI of the joint distribution of (X_i, X_{i+d}); using the pair-derived
 * marginals (rather than the global unigram) is what makes the a==b and edge
 * bookkeeping consistent.
 */
function rawMutualInformation(seq, d) {
	const numPairs = seq.length - d;
	if (numPairs <= 0) {
		return 0;
	}

	const joint = new Map(); // key -> { a, b, count }
	const first = new Map(); // symbol at position i -> count
	const second = new Map(); // symbol at position i+d -> count
	for (let i = 0; i < numPairs; i++) {
		const a = seq[i];
		const b = seq[i + d];
		const key = a + SEP + b;
		const entry = joint.get(key);
		if (entry) {
			entry.count += 1;
		} else {
			joint.set(key, { a, b, count: 1 });
		}
		first.set(a, (first.get(a) || 0) + 1);
		second.set(b, (second.get(b) || 0) + 1);
	}

	let mi = 0;
	for (const { a, b, count } of joint.values()) {
		const pab = count / numPairs;
		const pa = first.get(a) / numPairs;
		const pb = second.get(b) / numPairs;
		mi += pab * Math.log2(pab / (pa * pb));
	}
	return mi;
}

/**
 * Mutual-information decay curve with a shuffled null baseline.
 * Receives:
 *   - `seq`  the symbol sequence;
 *   - `maxD` the largest distance to evaluate (curve covers d = 1..maxD);
 *   - options: { shuffles = 20, rng } — number of independent shuffles for the
 *              baseline, and the injected [0,1) generator (seed it in tests).
 * Returns: an array (one entry per d) of {
 *   d,
 *   mi:             raw I(d) on the real sequence;
 *   miShuffledMean: mean of I(d) over the shuffled surrogates (the null baseline);
 *   miShuffledStd:  sample standard deviation of that shuffled I(d);
 *   miCorrected:    mi − miShuffledMean — the bias-subtracted estimate;
 *   adequate:       false when the pair count (seq.length − d) is small relative
 *                   to alphabetSize² (flagged when pairs < 5·alphabetSize²).
 * }
 *
 * WHY subtract a shuffled baseline: on finite data, plug-in MI is biased UPWARD —
 * even an order-less sequence shows I(d) > 0 purely from sampling. Shuffling
 * destroys all order while preserving the alphabet and length, so the shuffled MI
 * estimates that bias floor at each d; miCorrected subtracts it. WHY the `adequate`
 * flag: the joint has alphabetSize² cells, and once the number of observed pairs
 * drops toward that many, the estimate is dominated by noise. Flagging pairs <
 * 5·alphabetSize² marks exactly the data-starved tail where a spurious long-range
 * signal would otherwise appear.
 *
 * The `shuffles` surrogates are generated ONCE and reused across all distances, so
 * a single seeded rng makes the whole curve deterministic.
 */
export function mutualInformationDecay(seq, maxD, { shuffles = 20, rng = Math.random } = {}) {
	const alphabetSize = new Set(seq).size;
	const adequacyFloor = 5 * alphabetSize * alphabetSize;

	// Pre-generate the shuffled surrogates (bounded by `shuffles`, an explicit cap).
	const surrogates = [];
	for (let s = 0; s < shuffles; s++) {
		surrogates.push(shuffle(seq, rng));
	}

	// Clamp the caller-supplied bound (Power-of-Ten rule 2: make the outside-supplied
	// loop bound explicit). At d >= seq.length there are zero pairs, so I(d) is
	// trivially 0; seq.length - 1 is the largest d with at least one pair. Iterating
	// past it would pad the curve with meaningless zero-tail points and let a caller's
	// maxD drive a loop unbounded relative to the data. For an empty/singleton seq
	// this is <= 0, so the loop below runs zero times and an empty curve is returned.
	const effMaxD = Math.min(maxD, seq.length - 1);

	const curve = [];
	for (let d = 1; d <= effMaxD; d++) {
		const mi = rawMutualInformation(seq, d);

		// Shuffled baseline at this distance: mean and sample std over surrogates.
		const shuffledValues = surrogates.map((s) => rawMutualInformation(s, d));
		const mean = shuffledValues.reduce((acc, v) => acc + v, 0) / (shuffledValues.length || 1);
		let variance = 0;
		if (shuffledValues.length > 1) {
			for (const v of shuffledValues) {
				variance += (v - mean) * (v - mean);
			}
			variance /= shuffledValues.length - 1; // sample variance (N-1)
		}
		const std = Math.sqrt(variance);

		const numPairs = seq.length - d;
		curve.push({
			d,
			mi,
			miShuffledMean: mean,
			miShuffledStd: std,
			miCorrected: mi - mean,
			adequate: numPairs >= adequacyFloor,
		});
	}
	return curve;
}
