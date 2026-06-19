// barkley.js — the EXCITABLE-MEDIUM core: the Barkley model, which produces the rotating spiral and
// target waves of the Belousov–Zhabotinsky reaction (the mesmerising NileRed dish). It's the OTHER
// face of reaction-diffusion: where Gray-Scott settles into stationary patterns (spots, stripes),
// an excitable medium carries TRAVELLING waves that annihilate on collision and curl into spirals.
//
// Two fields: u (the fast "excitation", like the colour front) and v (the slow "recovery", the
// refractory wake a wave leaves behind that briefly can't re-fire):
//   ∂u/∂t = ∇²u + (1/ε)·u·(1−u)·(u − (v+b)/a)     u flips on past a threshold set by v, then off
//   ∂v/∂t = u − v                                  v chases u (the recovery variable), more slowly
// Only u diffuses (the classic Barkley choice). a, b shape the excitation threshold; ε≪1 makes u the
// fast variable. The magic is the cubic nullcline (u − (v+b)/a): it's why a wave can't immediately
// re-enter its own refractory tail, which is exactly what forces a broken wavefront to spiral.

export const A = 0.75, B = 0.06, EPS = 0.02;   // canonical spiral-forming parameters

export function makeBarkley(w, h) {
	const n = w * h;
	return { u: new Float32Array(n), v: new Float32Array(n), u2: new Float32Array(n), v2: new Float32Array(n), w, h, display: 'u' };
}

// seedSpiral — the textbook cross-gradient seed for ONE rotating spiral: a step in u along x crossed
// with a step in v along y. The whole LEFT HALF is excited (u=1), giving a vertical wavefront at x=w/2;
// the whole BOTTOM HALF is refractory (v=0.5). That front is free to advance rightward where the medium
// is rested (the top half) but is held back where it's refractory (the bottom half) — so it BREAKS at
// mid-height, and that single free tip at (w/2, h/2) has open medium ahead and a refractory wake behind,
// leaving it no choice but to curl in on itself and spin up a spiral. Requires the no-flux boundaries in
// stepBarkley; on a torus the wave arms wrap and collide, shattering the rotor into a labyrinth instead.
export function seedSpiral(st) {
	const { u, v, w, h } = st;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			u[i] = x < w / 2 ? 1 : 0;
			v[i] = y > h / 2 ? 0.5 : 0;
		}
}

// seedTargets — a few scattered excited dots on a rested medium; each fires an expanding ring, giving
// the concentric "target wave" look (BZ pacemaker sites).
export function seedTargets(st, rand = Math.random) {
	const { u, v, w, h } = st;
	u.fill(0); v.fill(0);
	for (let s = 0; s < 5; s++) {
		const cx = (rand() * w) | 0, cy = (rand() * h) | 0;
		for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
			const x = ((cx + dx) % w + w) % w, y = ((cy + dy) % h + h) % h;
			u[y * w + x] = 1;
		}
	}
}

export function clearBarkley(st) { st.u.fill(0); st.v.fill(0); }

// stampBarkley — excite a disk under the user's brush (set u=1), so they can trigger new waves.
export function stampBarkley(st, cx, cy, r) {
	const { u, w, h } = st;
	for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
		if (dx * dx + dy * dy > r * r) continue;
		u[(((cy + dy) % h + h) % h) * w + (((cx + dx) % w + w) % w)] = 1;
	}
}

// stepBarkley — one explicit Euler step. `du` is the diffusion coefficient on u; it must be large
// enough (relative to the recovery timescale) for the wave to outrun its own refractory wake, or the
// excitation just dies instead of propagating. dt is kept so dt·du stays well under the explicit
// diffusion-stability limit; u is clamped to [0,1]. Only u diffuses (the classic Barkley choice).
export function stepBarkley(st, a, b, eps, dt, du = 1) {
	const { u, v, u2, v2, w, h } = st;
	const inv = 1 / eps;
	for (let y = 0; y < h; y++) {
		// NO-FLUX (Neumann) boundaries: clamp at the edges instead of wrapping. A torus would let the
		// spiral's wave arms wrap around and collide with themselves, shattering one rotor into a
		// labyrinth of wavelets; a reflecting box lets a single spiral sit and rotate cleanly.
		const yc = y * w, ym = (y === 0 ? 0 : y - 1) * w, yp = (y === h - 1 ? h - 1 : y + 1) * w;
		for (let x = 0; x < w; x++) {
			const xm = x === 0 ? 0 : x - 1, xp = x === w - 1 ? w - 1 : x + 1, i = yc + x;
			const uu = u[i], vv = v[i];
			const lap = (u[yc + xm] + u[yc + xp] + u[ym + x] + u[yp + x]) * 0.2
				+ (u[ym + xm] + u[ym + xp] + u[yp + xm] + u[yp + xp]) * 0.05 - uu;
			let nu = uu + dt * (du * lap + inv * uu * (1 - uu) * (uu - (vv + b) / a));
			if (nu < 0) nu = 0; else if (nu > 1) nu = 1;
			u2[i] = nu;
			v2[i] = vv + dt * (uu - vv);
		}
	}
	[st.u, st.u2] = [st.u2, st.u];
	[st.v, st.v2] = [st.v2, st.v];
}
