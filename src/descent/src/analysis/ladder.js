// THE NULL LADDER — the centre of this project.
//
// A single number like "1.60 bits of mutual information between adjacent codas"
// sounds like evidence of sequential structure. It mostly is not. Each rung below
// removes ONE rival explanation for that number, and the number falls:
//
//   global shuffle .......... 1.60   (nothing controlled)
//   within-whale ............ 1.48   (whales differ in repertoire)
//   within-day .............. 1.12   (a recording day has its own context)
//   within-(day,whale) ...... 0.98   (a session with one animal)
//   + drop NOISE labels ..... 0.97   (annotation artifacts are not vocalizations)
//   + collapse repeat-runs .. 0.46   (whales repeat the same coda; that is not syntax)
//
// The descent IS the lesson. The reader walks down it and watches an impressive
// claim shrink to a modest one — that nonetheless refuses to reach zero.
//
// Every rung answers the same question with a different null: "compared to what?"
// A null is a surrogate sequence that keeps some property of the real data and
// destroys the rest. If the measured structure survives a null, that null's property
// does not explain it.

import { millerMadowEntropy } from './entropy.js';
import { shuffle } from './surrogate.js';

// Composite-key separator: control char U+0001, which does not occur in this corpus's
// coda-type labels (a property of THIS input, not a guaranteed-impossible byte). Built
// via fromCharCode so no raw control byte lives in source. Joining with it rather than
// "" stops distinct pairs from colliding, e.g. ["5R","3"] vs ["5","R3"].
const SEP = String.fromCharCode(1);

/**
 * Group codas into ordered blocks by a grouping key.
 * Receives: `codas` (parsed records) and `keyOf` (record -> string grouping key).
 * Returns: an array of blocks, each an array of codaType symbols in original order.
 *
 * Blocks are the unit of both measurement and shuffling: adjacent PAIRS are only
 * ever counted WITHIN a block, so a pair never straddles two recording sessions.
 * Without this, the "adjacent" in "adjacent codas" quietly includes the seam between
 * a whale in 2005 and a different whale in 2018 — an adjacency that exists in the
 * CSV, not in the ocean.
 *
 * Blocks shorter than 2 are dropped: they contain no adjacent pair and would only
 * add noise to the marginals.
 */
export function groupIntoBlocks(codas, keyOf) {
	const groups = new Map();
	for (const coda of codas) {
		const key = keyOf(coda);
		if (!groups.has(key)) {
			groups.set(key, []);
		}
		groups.get(key).push(coda.codaType);
	}
	return [...groups.values()].filter((block) => block.length >= 2);
}

/**
 * Collapse runs of the identical symbol down to one occurrence, per block.
 * Receives: `blocks` (array of symbol arrays).
 * Returns: new blocks with consecutive duplicates merged, length>=2 blocks only.
 *
 * WHY this is a null and not just cleanup: 71.6% of adjacent codas in this corpus are
 * literally the SAME type — whales repeat a coda in a bout. Repetition is real
 * behaviour, but it is not evidence of a combinatorial code, and it dominates any
 * adjacency statistic. Collapsing runs asks the sharper question: once you ignore
 * "it said the same thing again", is there still structure in WHICH type follows
 * WHICH? (Answering it fairly also requires the no-repeat null below — see
 * shuffleBlocksNoRepeat.)
 */
export function collapseRuns(blocks) {
	return blocks
		.map((block) => {
			const collapsed = [];
			for (const symbol of block) {
				if (collapsed.length === 0 || collapsed[collapsed.length - 1] !== symbol) {
					collapsed.push(symbol);
				}
			}
			return collapsed;
		})
		.filter((block) => block.length >= 2);
}

/**
 * Mutual information between adjacent symbols, counted only WITHIN blocks, in BITS.
 * Receives: `blocks` (array of symbol arrays).
 * Returns: { mi, pairs, alphabetSize } where mi is the plug-in estimate
 *          I = Σ P(a,b) log2[ P(a,b) / (P(a)P(b)) ] over within-block adjacent pairs.
 *
 * Marginals come from the pair set itself (P(a) over first positions, P(b) over
 * second), which is what makes the estimate internally consistent at block edges.
 * This is the RAW plug-in value: positively biased on finite data. It is never
 * reported alone — ladderRung subtracts a matched null and reports the spread.
 */
export function blockPairMI(blocks) {
	const joint = new Map();
	const first = new Map();
	const second = new Map();
	let pairs = 0;
	for (const block of blocks) {
		for (let i = 0; i < block.length - 1; i++) {
			const a = block[i];
			const b = block[i + 1];
			// U+0001 does not occur in this corpus's coda-type labels, so it is a safe
			// composite-key separator (a property of THIS input, not a guaranteed byte).
			const key = a + SEP + b;
			joint.set(key, (joint.get(key) || 0) + 1);
			first.set(a, (first.get(a) || 0) + 1);
			second.set(b, (second.get(b) || 0) + 1);
			pairs += 1;
		}
	}
	if (pairs === 0) {
		return { mi: 0, pairs: 0, alphabetSize: 0 };
	}
	let mi = 0;
	for (const [key, count] of joint) {
		const sep = key.indexOf(SEP);
		const a = key.slice(0, sep);
		const b = key.slice(sep + 1);
		const pab = count / pairs;
		const pa = first.get(a) / pairs;
		const pb = second.get(b) / pairs;
		mi += pab * Math.log2(pab / (pa * pb));
	}
	const alphabetSize = new Set([...first.keys(), ...second.keys()]).size;
	return { mi, pairs, alphabetSize };
}

/**
 * Null: shuffle symbols independently WITHIN each block.
 * Receives: `blocks`, `rng` (injected [0,1) generator).
 * Returns: new blocks, same per-block composition, order destroyed inside each block.
 *
 * This is the workhorse null. It preserves exactly what the rung is controlling for
 * (which symbols occurred in this session/whale/day) and destroys only their ORDER.
 */
export function shuffleBlocks(blocks, rng) {
	return blocks.map((block) => shuffle(block, rng));
}

/**
 * Null: shuffle within each block, CONSTRAINED so no two adjacent symbols are equal.
 * Receives: `blocks`, `rng`.
 * Returns: { blocks, failedBlocks } — the surrogate, plus the number of blocks on which
 *          THIS CALL'S bounded search gave up before finding a valid arrangement
 *          (those blocks are returned plain-shuffled instead).
 *
 * READ THE RETURN NAME CAREFULLY, because it has already been misread once. A block
 * counted in `failedBlocks` is one where a randomized search hit its retry budget, NOT
 * one where a valid arrangement is impossible. The two are different claims and only
 * the first is what this function measures. Measured on the 135 blocks of this
 * project's last rung: zero of them are infeasible, and give-ups concentrate on the
 * three blocks whose commonest symbol sits closest to the ceil(n/2) bound, where valid
 * arrangements are rarest and a random search is least likely to land on one in time.
 *
 * WHY this null must exist: after collapseRuns the REAL sequence has zero adjacent
 * repeats BY CONSTRUCTION, while a plain shuffle of it reintroduces ~21% repeats.
 * Comparing those two is rigged — it credits the real data for a property the
 * collapse operation forced on it, inflating the result (0.68 vs the honest 0.46).
 * A fair null must share the constraint. This is the difference between an artifact
 * that teaches honesty and one that performs it.
 *
 * Feasibility versus success are separate questions, and this function only answers the
 * second. An arrangement with no adjacent repeats EXISTS whenever the most common
 * symbol occupies at most ceil(n/2) slots. Finding one is left to bounded randomized
 * retry, so a give-up recorded below means the search ran out of budget, never that the
 * arrangement does not exist. Give-ups are COUNTED and reported rather than silently
 * dropped: a hidden fallback to a plain shuffle weakens the null and makes the finding
 * look stronger than it is.
 */
export function shuffleBlocksNoRepeat(blocks, rng) {
	const MAX_RESTARTS = 40; // bounded (Power-of-Ten rule 2): give up and report, never spin
	const MAX_SWAP_TRIES = 60;
	let failedBlocks = 0;
	const out = blocks.map((block) => {
		for (let attempt = 0; attempt < MAX_RESTARTS; attempt++) {
			const candidate = shuffle(block, rng);
			let repaired = true;
			for (let i = 1; i < candidate.length; i++) {
				if (candidate[i] !== candidate[i - 1]) {
					continue;
				}
				// Try to swap this duplicate with a random partner, checking that the swap
				// does not create a new adjacency violation at either site.
				let fixed = false;
				for (let t = 0; t < MAX_SWAP_TRIES; t++) {
					const j = Math.floor(rng() * candidate.length);
					const a = candidate[i];
					const b = candidate[j];
					if (a === b) {
						continue;
					}
					const okAtI = candidate[i - 1] !== b
						&& (i + 1 >= candidate.length || candidate[i + 1] !== b);
					const okAtJ = (j === 0 || candidate[j - 1] !== a)
						&& (j + 1 >= candidate.length || candidate[j + 1] !== a);
					if (okAtI && okAtJ) {
						candidate[i] = b;
						candidate[j] = a;
						fixed = true;
						break;
					}
				}
				if (!fixed) {
					repaired = false;
					break;
				}
			}
			if (repaired) {
				let clean = true;
				for (let i = 1; i < candidate.length; i++) {
					if (candidate[i] === candidate[i - 1]) {
						clean = false;
						break;
					}
				}
				if (clean) {
					return candidate;
				}
			}
		}
		failedBlocks += 1;
		return shuffle(block, rng);
	});
	return { blocks: out, failedBlocks };
}

/**
 * Evaluate ONE rung of the ladder: measure the real data against a matched null.
 * Receives:
 *   - `blocks`    the (already grouped, already collapsed if applicable) real blocks;
 *   - `options`   { surrogates = 20, rng, noRepeat = false }.
 * Returns: {
 *   mi,              raw plug-in MI of the real blocks (bits)
 *   nullMean,        mean MI across the surrogates — the bias floor for THIS null
 *   nullStd,         sample stdev across surrogates — the error bar
 *   corrected,       mi - nullMean, the structure this null does not explain
 *   zScore,          (mi - nullMean) / nullStd — how many null-widths above chance
 *   pairs,           within-block adjacent pairs the estimate rests on
 *   alphabetSize,
 *   entropyBits,     Miller-Madow entropy of the symbol distribution (context)
 *   failedNullBlocks, SUM over all surrogate draws of the per-draw give-up count from
 *                    shuffleBlocksNoRepeat (0 unless noRepeat). It accumulates inside
 *                    the draw loop below, so it counts ATTEMPTS across the whole set of
 *                    null models, not distinct blocks: one stubborn block that defeats
 *                    the search on four separate draws contributes 4. Anything reported
 *                    to a reader from this field must be phrased as attempts. Turning it
 *                    into a per-block figure would mean returning block identities from
 *                    shuffleBlocksNoRepeat, which is a deliberate non-change here
 *                    because it would alter published numbers.
 *   reliable,        false when the estimate is too data-starved to trust
 * }
 *
 * WHY report nullStd and zScore rather than just `corrected`: a corrected MI of 0.46
 * bits means nothing without knowing how much the null itself wanders. Reporting the
 * spread is what lets a reader see "clearly above chance" versus "inside the noise",
 * and it is the honest counterpart to the shrinking headline number.
 *
 * `reliable` is deliberately CONSERVATIVE (over-flagging is the safe direction here):
 * it demands at least 5 observed pairs per cell of the alphabet² joint table. Below
 * that, MI is dominated by sampling and the UI should show an "insufficient data"
 * state rather than a number.
 */
export function ladderRung(blocks, { surrogates = 20, rng = Math.random, noRepeat = false } = {}) {
	const { mi, pairs, alphabetSize } = blockPairMI(blocks);

	const values = [];
	let failedNullBlocks = 0;
	for (let s = 0; s < surrogates; s++) {
		let surrogate;
		if (noRepeat) {
			const result = shuffleBlocksNoRepeat(blocks, rng);
			surrogate = result.blocks;
			failedNullBlocks += result.failedBlocks;
		} else {
			surrogate = shuffleBlocks(blocks, rng);
		}
		values.push(blockPairMI(surrogate).mi);
	}
	const nullMean = values.reduce((acc, v) => acc + v, 0) / (values.length || 1);
	let variance = 0;
	if (values.length > 1) {
		for (const v of values) {
			variance += (v - nullMean) * (v - nullMean);
		}
		variance /= values.length - 1;
	}
	const nullStd = Math.sqrt(variance);

	// Symbol-distribution entropy, for context on how much information a single coda
	// could carry at most. Miller-Madow because block counts are modest.
	const counts = new Map();
	for (const block of blocks) {
		for (const symbol of block) {
			counts.set(symbol, (counts.get(symbol) || 0) + 1);
		}
	}

	return {
		mi,
		nullMean,
		nullStd,
		corrected: mi - nullMean,
		zScore: nullStd > 0 ? (mi - nullMean) / nullStd : NaN,
		pairs,
		alphabetSize,
		entropyBits: millerMadowEntropy(counts),
		failedNullBlocks,
		reliable: pairs >= 5 * alphabetSize * alphabetSize,
	};
}

/**
 * The standard ladder: the sequence of rungs this project reports.
 * Receives: `codas` (parsed records) and { surrogates, rng }.
 * Returns: an array of { id, label, explains, ...ladderRung fields }, in descending
 *          order of how much the corrected number should fall.
 *
 * `explains` names the rival explanation that rung removes — the reason the number
 * drops. Every rung is computed from the SAME underlying data so the descent is a
 * like-for-like comparison, not four unrelated statistics.
 */
export function standardLadder(codas, { surrogates = 20, rng = Math.random } = {}) {
	const clean = codas.filter((c) => !/-NOISE$/i.test(c.codaType));
	const all = () => 'ALL';

	const rungs = [
		{
			id: 'global',
			label: 'No control',
			explains: 'nothing — every coda treated as adjacent to the next row in the file',
			blocks: groupIntoBlocks(codas, all),
			noRepeat: false,
		},
		{
			id: 'whale',
			label: 'Same whale',
			explains: 'different whales favour different codas',
			blocks: groupIntoBlocks(codas, (c) => c.whaleId),
			noRepeat: false,
		},
		{
			id: 'day',
			label: 'Same recording day',
			explains: 'a day of recording has its own context and cast',
			blocks: groupIntoBlocks(codas, (c) => c.date),
			noRepeat: false,
		},
		{
			id: 'session',
			label: 'Same whale, same day',
			explains: 'one animal within one session',
			blocks: groupIntoBlocks(codas, (c) => `${c.date}${SEP}${c.whaleId}`),
			noRepeat: false,
		},
		{
			id: 'session-clean',
			label: 'Same whale+day, annotation noise removed',
			explains: 'N-NOISE labels are measurement artifacts, not vocalizations',
			blocks: groupIntoBlocks(clean, (c) => `${c.date}${SEP}${c.whaleId}`),
			noRepeat: false,
		},
		{
			id: 'session-clean-norepeat',
			label: 'Same whale+day, clean, repetition removed',
			explains: 'whales repeat the same coda — repetition is not syntax',
			blocks: collapseRuns(groupIntoBlocks(clean, (c) => `${c.date}${SEP}${c.whaleId}`)),
			noRepeat: true,
		},
	];

	return rungs.map(({ blocks, noRepeat, ...meta }) => ({
		...meta,
		...ladderRung(blocks, { surrogates, rng, noRepeat }),
		blockCount: blocks.length,
	}));
}
