// sim.js — the Gray-Scott reaction-diffusion core.
//
// Two fields live on a W×H toroidal (wrap-around) grid: A (the substrate) and B (the
// autocatalyst). Every step, each cell follows two local rules — that's the whole engine:
//   A' = A + (Da·∇²A − A·B² + f·(1−A)) · dt     (A diffuses, is eaten by the reaction, is fed back)
//   B' = B + (Db·∇²B + A·B² − (k+f)·B) · dt     (B diffuses, is made by the reaction, decays)
// The A·B² term is the reaction: one A meets two B and becomes a third B (autocatalysis). With dt=1
// folded in (the standard discrete form), `f` (feed) and `k` (kill) are the two knobs that move the
// system across the whole zoo of patterns — spots, stripes, mazes, waves.
//
// ∇² is a 9-point Laplacian (orthogonal neighbours weighted 0.2, diagonals 0.05, centre −1). The
// weights sum to zero (a Laplacian must) and the diagonal terms make it more ISOTROPIC than a
// 5-point stencil, so patterns don't lock to the grid axes. Da=1.0, Db=0.5 are the canonical rates.

export const Da = 1.0, Db = 0.5;

// makeFields — allocate the A/B fields plus their double-buffers. A starts at 1 (full substrate),
// B at 0 (no autocatalyst). Returns the four flat Float32Arrays the stepper ping-pongs between.
export function makeFields(w, h) {
	const n = w * h;
	const a = new Float32Array(n).fill(1), b = new Float32Array(n);
	const a2 = new Float32Array(n), b2 = new Float32Array(n);
	return { a, b, a2, b2, w, h };
}

// seedSquare — drop a square of B (and half-strength A) at the centre, plus a little noise, to break
// symmetry so a pattern can nucleate. rand is an injectable RNG (default Math.random) for testability.
export function seedSquare(fields, side = 20, rand = Math.random) {
	const { a, b, w, h } = fields;
	const x0 = (w - side) >> 1, y0 = (h - side) >> 1;
	for (let y = y0; y < y0 + side; y++)
		for (let x = x0; x < x0 + side; x++) {
			const i = y * w + x;
			a[i] = 0.5 + (rand() - 0.5) * 0.02;
			b[i] = 0.25 + (rand() - 0.5) * 0.02;
		}
}

// step — advance the simulation by ONE Euler step (the hot loop). Reads a/b, writes a2/b2; the
// caller swaps the buffers. Wrap indices are precomputed per row/column so the inner loop has no
// modulo or branches. `f` = feed rate, `k` = kill rate.
export function step(fields, f, k) {
	const { a, b, a2, b2, w, h } = fields;
	for (let y = 0; y < h; y++) {
		const yc = y * w;
		const ym = (y === 0 ? h - 1 : y - 1) * w;
		const yp = (y === h - 1 ? 0 : y + 1) * w;
		for (let x = 0; x < w; x++) {
			const xm = x === 0 ? w - 1 : x + (-1);
			const xp = x === w - 1 ? 0 : x + 1;
			const i = yc + x;
			const av = a[i], bv = b[i];
			const lapA = (a[yc + xm] + a[yc + xp] + a[ym + x] + a[yp + x]) * 0.2
				+ (a[ym + xm] + a[ym + xp] + a[yp + xm] + a[yp + xp]) * 0.05 - av;
			const lapB = (b[yc + xm] + b[yc + xp] + b[ym + x] + b[yp + x]) * 0.2
				+ (b[ym + xm] + b[ym + xp] + b[yp + xm] + b[yp + xp]) * 0.05 - bv;
			const abb = av * bv * bv;                       // the autocatalytic reaction term
			a2[i] = av + (Da * lapA - abb + f * (1 - av));
			b2[i] = bv + (Db * lapB + abb - (k + f) * bv);
		}
	}
}

// swap — ping-pong the buffers after a step (a2/b2 become the current a/b). Returns fields for chaining.
export function swap(fields) {
	[fields.a, fields.a2] = [fields.a2, fields.a];
	[fields.b, fields.b2] = [fields.b2, fields.b];
	return fields;
}

// stamp — paint a filled disk of autocatalyst B (and depleted A) into the field, e.g. under the
// user's brush, so they can seed new pattern wherever they drag. cx/cy in grid cells; wraps toroidally.
export function stamp(fields, cx, cy, r) {
	const { a, b, w, h } = fields;
	for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
		if (dx * dx + dy * dy > r * r) continue;
		const x = ((cx + dx) % w + w) % w, y = ((cy + dy) % h + h) % h, i = y * w + x;
		b[i] = 0.9; a[i] = 0.1;
	}
}

// clear — reset to the homogeneous rest state (A=1 everywhere, B=0): a blank dish.
export function clear(fields) { fields.a.fill(1); fields.b.fill(0); }
