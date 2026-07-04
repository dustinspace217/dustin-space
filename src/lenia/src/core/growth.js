// Lenia growth mapping (the "exponential" / Gaussian form, gn=1 in Chan's
// taxonomy — the only growth type this project uses).
//
//   G(u) = 2 * exp(-(u - mu)^2 / (2 sigma^2)) - 1
//
// Receives: u     — the local "potential" (kernel-weighted neighborhood sum,
//                   produced by the convolution in sim.js / the GPU shader),
//           mu    — the potential value the species "likes" (growth center),
//           sigma — how tolerant it is around that value (growth width).
// Returns: a value in (-1, +1]: +1 at u = mu (max growth), negative when the
// neighborhood is too empty OR too crowded (decay). This one function is the
// entire "physics" of life and death in Lenia; everything else is bookkeeping.
export function growth(u, mu, sigma) {
	const d = (u - mu) / sigma;
	return 2 * Math.exp(-0.5 * d * d) - 1;
}
