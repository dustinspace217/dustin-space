// Lenia convolution kernel: a smooth ring (or set of concentric rings).
//
// The kernel defines what "neighborhood" means. Conway's Game of Life counts
// 8 neighbors equally; Lenia instead weights neighbors by a smooth bump that
// peaks at half the kernel radius — cells "sense" a fuzzy ring around
// themselves. This ring shape is why Lenia creatures are round and why they
// can glide: the sensed neighborhood has no grid-aligned corners.
//
// Formulas (verified against the Lenia paper + Chakazul's reference impl —
// see PLAN.md "Verified ground truth"):
//   core:  K_c(r) = exp(alpha - alpha / (4 r (1 - r))),  alpha = 4, r in (0,1)
//          — a smooth bump: 0 at r=0 and r=1, peak 1 at r=0.5.
//   shell: with B rings and peak heights beta[0..B-1]:
//          K_s(r) = beta[floor(B*r)] * K_c(B*r mod 1)
//   final: sampled on the (2R+1)^2 integer stencil at r = |offset| / R,
//          zero for r >= 1, then normalized so the weights sum to 1.
//
// Why normalize: it makes the convolution output u a weighted AVERAGE of the
// neighborhood (u in [0,1] when the world is in [0,1]), so the growth
// function's mu is comparable across kernel radii — Orbium's mu=0.15 means
// "15% average activation in my ring", independent of R.

const ALPHA = 4;

// The smooth bump at the heart of the kernel. Receives r in [0,1] (position
// within a single ring), returns the unnormalized weight.
function kernelCore(r) {
	// Guard the open interval: at r=0 or r=1 the exponent is -Infinity,
	// exp gives 0 — mathematically the right limit, but computing 4r(1-r)=0
	// would divide by zero first. Return the limit value directly instead.
	if (r <= 0 || r >= 1) return 0;
	return Math.exp(ALPHA - ALPHA / (4 * r * (1 - r)));
}

// Build the full sampled kernel stencil.
// Receives: R    — kernel radius in cells (Orbium uses 13),
//           beta — array of ring peak heights, e.g. [1] for one ring,
//                  [1, 0.5] for two rings with the outer at half strength.
// Returns: { size, weights } where size = 2R+1 and weights is a row-major
// Float64Array(size*size) summing to exactly 1 (up to float rounding).
// Consumed by: sim.js (embedded into the FFT grid) and gl/engine.js
// (uploaded as a texture for the shader to sample).
export function buildKernel(R, beta) {
	const size = 2 * R + 1;
	const weights = new Float64Array(size * size);
	const B = beta.length;
	let sum = 0;
	for (let dy = -R; dy <= R; dy++) {
		for (let dx = -R; dx <= R; dx++) {
			const r = Math.hypot(dx, dy) / R;   // normalized distance in [0, ~1.41]
			if (r >= 1) continue;                // outside the kernel disc
			const br = B * r;
			// Which ring are we in, and where within it? floor(br) picks the
			// ring index; (br mod 1) is the position across that ring's bump.
			const ring = Math.floor(br);
			const w = beta[ring] * kernelCore(br - ring);
			weights[(dy + R) * size + (dx + R)] = w;
			sum += w;
		}
	}
	// Normalize in place. sum can't be 0 for any sane (R >= 2, beta nonzero)
	// input; assert loudly rather than silently emitting NaNs downstream.
	if (!(sum > 0)) throw new Error(`kernel sum ${sum} — bad R=${R} / beta=${beta}`);
	for (let i = 0; i < weights.length; i++) weights[i] /= sum;
	return { size, weights };
}
