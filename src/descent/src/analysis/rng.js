// Seeded pseudo-random number generator.
//
// WHY a custom PRNG instead of Math.random: every randomizing function in this
// core (shuffle, markovSurrogate, and the shuffled MI baseline) takes an
// INJECTABLE rng so the tests are reproducible. Math.random cannot be seeded, so
// a surrogate/shuffle built on it would give different numbers every run and the
// known-answer tests could not assert exact tolerances. mulberry32 is a tiny,
// well-regarded 32-bit generator — not cryptographic, but statistically fine for
// shuffling symbol sequences and sampling surrogates, which is all we need here.

/**
 * Build a seeded PRNG.
 * Receives: `seed`, any integer (coerced to a 32-bit unsigned value).
 * Returns: a function that, each call, returns a float in [0, 1) — the same
 *          contract as Math.random, so it is a drop-in injectable rng.
 *
 * The bit-twiddling is the standard mulberry32 algorithm. `Math.imul` is
 * 32-bit integer multiplication (JS numbers are floats, so plain `*` would lose
 * precision on large products); `>>> 0` coerces to unsigned 32-bit; `^`, `>>>`
 * are XOR and unsigned right-shift. The constants are the published mulberry32
 * mixing constants — they are not tunable, changing them breaks the generator's
 * statistical quality.
 */
export function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
