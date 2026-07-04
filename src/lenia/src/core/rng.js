// Deterministic pseudo-random number generator.
//
// Why not Math.random(): the discovery search must be REPRODUCIBLE — every
// found creature is stored with the seed that produced it, so anyone (including
// a future session) can replay the exact run that discovered it. Math.random()
// cannot be seeded. Mulberry32 is a tiny, well-tested 32-bit generator with
// good statistical quality for simulation seeding (not cryptography).
//
// Receives: an integer seed. Returns: a function that yields floats in [0, 1).
export function mulberry32(seed) {
	// >>> 0 forces the seed into an unsigned 32-bit integer — JS bitwise ops
	// work on 32-bit values, so this keeps all the arithmetic in that domain.
	let a = seed >>> 0;
	return function () {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		// The magic constants and shift/multiply mixing are the published
		// mulberry32 recipe (Tommy Ettinger, public domain) — don't "tidy" them.
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
