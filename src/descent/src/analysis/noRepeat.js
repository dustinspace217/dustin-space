// Sampling the last rung's null without repairing shuffles. Repairing a duplicate
// changes the odds of otherwise valid arrangements; counting valid completions
// instead gives every arrangement the same chance. The recurrence is the verified
// count_g/count_f reference from the independent 2026-09-03 rederivation.
import { shuffle } from './surrogate.js';

// Measured on all current shapes: 658,323 unrestricted states. This cap leaves
// headroom without the reference implementation's multi-million-entry cache.
const MAX_STATES = 750_000;
const REJECTION_ATTEMPTS = 64;
const MAX_DP_LENGTH = 74; // Largest verified exact block; longer DP work is skipped and disclosed.

/** Draw an integer below positive BigInt `limit` from the injected rng.
 * Returns a BigInt. Masked rejection avoids both float rounding of large counts
 * and modulo bias. The 128-attempt cap reports a broken RNG instead of hanging. */
export function randomBelow(limit, rng) {
	if (limit <= 0n) throw new RangeError('The random integer limit must be positive.');
	if (limit === 1n) return 0n;
	const bits = (limit - 1n).toString(2).length;
	const words = Math.ceil(bits / 32);
	const mask = (1n << BigInt(bits)) - 1n;
	for (let attempt = 0; attempt < 128; attempt++) {
		let value = 0n;
		for (let i = 0; i < words; i++) {
			const part = rng();
			if (!(part >= 0 && part < 1)) throw new RangeError('The RNG must return a value in [0, 1).');
			value = (value << 32n) | BigInt(Math.floor(part * 4294967296));
		}
		value &= mask;
		if (value < limit) return value;
	}
	throw new Error('The RNG exhausted the bounded integer-draw attempts.');
}

/** Count symbol multiplicities in a block; returns a new Map used by each walk. */
function multiplicities(block) {
	const counts = new Map();
	for (const symbol of block) counts.set(symbol, (counts.get(symbol) || 0) + 1);
	return counts;
}

/** Canonicalize positive remaining counts; returns a descending array.
 * Symbol identities disappear only in the counter: equally numerous symbols have
 * identical completion counts, while sampling still chooses their actual names. */
function shape(values) {
	return [...values].filter((n) => n > 0).sort((a, b) => b - a);
}

/** Build a bounded completion counter for ONE ladder run, never global state.
 * Receives the entry budget; returns count, prepare, and a read-only size.
 * Overflow rolls back just the unfinished shape's new entries. Keeping earlier
 * complete tables avoids making one large block poison all the smaller blocks. */
export function createCompletionCounter(maxStates = MAX_STATES) {
	if (!Number.isSafeInteger(maxStates) || maxStates < 0 || maxStates > MAX_STATES) {
		throw new RangeError(`The completion-cache budget must be between 0 and ${MAX_STATES}.`);
	}
	const cache = new Map();
	let additions = null;

	/** Count suffixes for sorted `counts`, excluding the preceding symbol whose
	 * remaining multiplicity is `forbidden`; returns BigInt, or null on budget hit.
	 * A forbidden step delegates to an unrestricted count at the same length, then
	 * removes one symbol. Depth is therefore bounded by twice MAX_DP_LENGTH. */
	function count(counts, forbidden = 0) {
		if (counts.length === 0) return 1n;
		const totalLength = counts.reduce((sum, n) => sum + n, 0);
		if (totalLength > MAX_DP_LENGTH) return null;
		if (counts[0] > Math.ceil(totalLength / 2) || forbidden > Math.floor(totalLength / 2)) return 0n;
		if (forbidden > 0) {
			// F(c, k) = G(c) - F(c minus one k, k - 1): remove exactly the
			// arrangements beginning with the forbidden symbol. This is the same
			// recurrence with only G memoized, avoiding a separate cached copy for
			// every possible preceding count. Both terms remain exact BigInts.
			const all = count(counts);
			if (all === null) return null;
			const next = counts.slice();
			next.splice(next.indexOf(forbidden), 1);
			if (forbidden > 1) next.push(forbidden - 1);
			const excluded = count(shape(next), forbidden - 1);
			return excluded === null ? null : all - excluded;
		}
		const key = String.fromCharCode(...counts, 0, forbidden);
		if (cache.has(key)) return cache.get(key);
		if (cache.size >= maxStates) return null;
		let total = 0n;
		for (const value of new Set(counts)) {
			const copies = counts.filter((n) => n === value).length;
			const next = counts.slice();
			next.splice(next.indexOf(value), 1);
			if (value > 1) next.push(value - 1);
			const suffixes = count(shape(next), value - 1);
			if (suffixes === null) return null;
			total += BigInt(copies) * suffixes;
		}
		if (cache.size >= maxStates) return null;
		cache.set(key, total);
		if (additions) additions.push(key);
		return total;
	}

	/** Prepare all suffix counts for a full multiset; return its count or null.
	 * The rollback journal is bounded by the same entry cap as the cache. */
	function prepare(counts) {
		if (counts.reduce((sum, n) => sum + n, 0) > MAX_DP_LENGTH) return null;
		additions = [];
		const total = count(shape(counts));
		if (total === null) for (const key of additions) cache.delete(key);
		additions = null;
		return total;
	}
	return { count, prepare, get size() { return cache.size; } };
}

/** Sample one block from a completed DP table; returns its repeat-free order.
 * Each possible next symbol is weighted by its number of valid suffixes. BigInt
 * weights are kept intact all the way through the draw, even above 2^53. */
function exactSample(block, counter, rng) {
	const remaining = multiplicities(block);
	const result = [];
	let last;
	for (let i = 0; i < block.length; i++) {
		const candidates = [];
		let total = 0n;
		for (const [symbol, value] of remaining) {
			if (value === 0 || symbol === last) continue;
			remaining.set(symbol, value - 1);
			const weight = counter.count(shape(remaining.values()), value - 1);
			remaining.set(symbol, value);
			if (weight === null) throw new Error('A prepared no-repeat table is incomplete.');
			candidates.push([symbol, weight]);
			total += weight;
		}
		let pick = randomBelow(total, rng);
		for (const [symbol, weight] of candidates) {
			if (pick < weight) {
				result.push(symbol);
				remaining.set(symbol, remaining.get(symbol) - 1);
				last = symbol;
				break;
			}
			pick -= weight;
		}
	}
	return result;
}

/** Make one bounded greedy walk; returns an order, or null on a dead end.
 * `maxFirst` chooses the most numerous available symbol with random tie breaks.
 * Both modes are deliberately labelled approximate: neither weights suffixes. */
function greedyWalk(block, rng, maxFirst) {
	const remaining = multiplicities(block);
	const result = [];
	let last;
	for (let i = 0; i < block.length; i++) {
		let choices = [...remaining].filter(([symbol, n]) => n > 0 && symbol !== last);
		if (choices.length === 0) return null;
		if (maxFirst) {
			const top = Math.max(...choices.map(([, n]) => n));
			choices = choices.filter(([, n]) => n === top);
		}
		const [chosen, count] = choices[Math.floor(rng() * choices.length)];
		result.push(chosen);
		remaining.set(chosen, count - 1);
		last = chosen;
	}
	return result;
}

/** Use up to 50 random walks, then a most-numerous-first walk; return an order.
 * For feasible inputs the final walk can finish without repeating a neighbour.
 * A null return is still checked by the caller rather than silently published. */
function approximateSample(block, rng) {
	for (let attempt = 0; attempt < 50; attempt++) {
		const result = greedyWalk(block, rng, false);
		if (result) return result;
	}
	return greedyWalk(block, rng, true);
}

/** Prepare a run-local sampler; receives blocks and optional testable budgets.
 * Returns a draw(rng) function. Its cache and remembered overflow shapes live only
 * as long as the rung, bounded by maxStates and the input's distinct shapes.
 * Rejection and exact DP target the same uniform distribution. On resource limits
 * the valid but nonuniform fallback is reported separately from plain failures. */
export function createNoRepeatSampler(blocks, { maxStates = MAX_STATES,
	rejectionAttempts = REJECTION_ATTEMPTS } = {}) {
	if (!Number.isSafeInteger(rejectionAttempts) || rejectionAttempts < 0 || rejectionAttempts > REJECTION_ATTEMPTS) {
		throw new RangeError(`The rejection budget must be between 0 and ${REJECTION_ATTEMPTS}.`);
	}
	const counter = createCompletionCounter(maxStates);
	const methods = new Map();
	const entries = blocks.map((block) => {
		const counts = shape(multiplicities(block).values());
		return { block, counts, key: counts.join(','), feasible: (counts[0] || 0) <= Math.ceil(block.length / 2) };
	});

	/** Draw all blocks; returns orders, plain-failure count, and approximate indices.
	 * Indices let the rung distinguish draw attempts from distinct affected blocks. */
	return function draw(rng) {
		let failedBlocks = 0;
		const approximateBlockIndices = [];
		const out = entries.map(({ block, counts, key, feasible }, index) => {
			if (!feasible) {
				failedBlocks++;
				return shuffle(block, rng);
			}
			if (!methods.has(key)) {
				for (let attempt = 0; attempt < rejectionAttempts; attempt++) {
					const candidate = shuffle(block, rng);
					if (candidate.every((symbol, i) => i === 0 || symbol !== candidate[i - 1])) return candidate;
				}
				const total = counter.prepare(counts);
				methods.set(key, total === null ? 'approximate' : 'exact');
			}
			if (methods.get(key) === 'exact') return exactSample(block, counter, rng);
			approximateBlockIndices.push(index);
			const result = approximateSample(block, rng);
			if (!result) throw new Error('The no-repeat fallback could not arrange a feasible block.');
			return result;
		});
		return { blocks: out, failedBlocks, approximateBlockIndices };
	};
}
