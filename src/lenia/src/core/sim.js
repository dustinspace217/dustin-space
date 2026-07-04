// CPU Lenia engine: a torus world stepped by FFT convolution + growth.
//
// This is the engine the discovery search and the test suite run on. The
// browser uses the WebGL engine in src/gl/engine.js instead; both implement
// the SAME update rule (PLAN.md "Verified ground truth"):
//
//   A'(x) = clip( A(x) + (1/T) * G( (K * A)(x) ), 0, 1 )
//
// and the QA phase cross-checks them on identical inputs (GPU-vs-CPU parity).

import { buildKernel } from './kernel.js';
import { growth } from './growth.js';
import { cyclicConvolve2d } from './fft.js';

export class CpuSim {
	// Receives: n — world size in cells (power of 2 for the FFT),
	//           params — { R, T, mu, sigma, beta } (Lenia species parameters).
	constructor(n, { R, T, mu, sigma, beta }) {
		if ((n & (n - 1)) !== 0) throw new Error(`world size ${n} not a power of 2`);
		this.n = n;
		this.R = R; this.T = T; this.mu = mu; this.sigma = sigma;
		this.beta = beta.slice();
		this.kernel = buildKernel(R, beta);
		// The world state, row-major, values in [0,1]. Preallocated once —
		// step() never allocates beyond the FFT's internal fixed scratch
		// (bounded-memory rule; the search runs millions of steps).
		this.world = new Float64Array(n * n);
		this.t = 0;   // elapsed time units (T steps = 1 unit)
	}

	// Wipe the world for the next run, keeping the kernel (and its cached
	// FFT spectrum) — the search reuses ONE sim instance for thousands of
	// runs, so reset must not allocate.
	reset() {
		this.world.fill(0);
		this.t = 0;
	}

	// Change growth parameters without rebuilding the kernel — the UI sliders
	// and the search's parameter sweep both move (mu, sigma) while (R, beta)
	// stay fixed, and the kernel FFT cache keys on the kernel object.
	setParams({ mu, sigma }) {
		if (mu !== undefined) this.mu = mu;
		if (sigma !== undefined) this.sigma = sigma;
	}

	// One simulation step (1/T time units).
	step() {
		const { n, world } = this;
		const u = cyclicConvolve2d(world, n, this.kernel);
		const dt = 1 / this.T;
		for (let i = 0; i < n * n; i++) {
			const v = world[i] + dt * growth(u[i], this.mu, this.sigma);
			// clip to [0,1] — the update rule's saturation, not a safety hack.
			world[i] = v < 0 ? 0 : v > 1 ? 1 : v;
		}
		this.t += dt;
	}

	// Total activation. The detectors read this every T steps: near-zero
	// means the pattern died; approaching a large fraction of n*n means it
	// exploded into space-filling texture.
	mass() {
		let m = 0;
		const w = this.world;
		for (let i = 0; i < w.length; i++) m += w[i];
		return m;
	}

	// Mass centroid on the torus, via the circular-mean trick: map each
	// coordinate to an angle on a circle, average the unit vectors, take the
	// angle of the mean. A plain arithmetic mean is WRONG on a torus — a
	// creature straddling the wrap seam would average to the middle of the
	// map, poisoning every downstream speed measurement.
	// Returns {x, y} in [0, n), or null if the world is (near-)empty.
	centroid() {
		const { n, world } = this;
		let sxc = 0, sxs = 0, syc = 0, sys = 0, m = 0;
		for (let y = 0; y < n; y++) {
			const ay = 2 * Math.PI * y / n;
			const cy = Math.cos(ay), sy = Math.sin(ay);
			for (let x = 0; x < n; x++) {
				const w = world[y * n + x];
				if (w === 0) continue;
				const ax = 2 * Math.PI * x / n;
				sxc += w * Math.cos(ax); sxs += w * Math.sin(ax);
				syc += w * cy; sys += w * sy;
				m += w;
			}
		}
		if (m < 1e-9) return null;
		const wrap = (a) => (a < 0 ? a + 2 * Math.PI : a);
		return {
			x: wrap(Math.atan2(sxs / m, sxc / m)) * n / (2 * Math.PI),
			y: wrap(Math.atan2(sys / m, syc / m)) * n / (2 * Math.PI),
		};
	}

	// Stamp a decoded creature ({w, h, data}) so its top-left lands at
	// (cx, cy), wrapping around the torus. Values REPLACE what's underneath
	// (matches the reference implementation's board-place semantics).
	placeCells(cells, cx, cy) {
		const { n, world } = this;
		for (let y = 0; y < cells.h; y++) {
			const ty = ((cy + y) % n + n) % n;
			for (let x = 0; x < cells.w; x++) {
				const tx = ((cx + x) % n + n) % n;
				world[ty * n + tx] = cells.data[y * cells.w + x];
			}
		}
	}

	// Seed a fuzzy random blob centered on the map — the discovery search's
	// starting soup. Gaussian falloff times uniform noise, so the blob has
	// soft edges (hard edges couple badly with the smooth kernel and die).
	// Receives: rng — a mulberry32-style () => [0,1) function,
	//           radius — blob radius in cells, amp — peak amplitude.
	seedNoise(rng, radius, amp) {
		const { n, world } = this;
		const c = n / 2;
		for (let y = 0; y < n; y++) {
			for (let x = 0; x < n; x++) {
				const d2 = ((x - c) ** 2 + (y - c) ** 2) / (radius * radius);
				if (d2 > 1) continue;
				world[y * n + x] = Math.min(1, amp * rng() * Math.exp(-3 * d2));
			}
		}
	}

	// Crop a (2r+1)^2 window centered on (cx, cy) with torus wrap — used by
	// the curator to cut a discovered creature out of its world.
	crop(cx, cy, r) {
		const { n, world } = this;
		const size = 2 * r + 1;
		const data = new Float64Array(size * size);
		const x0 = Math.round(cx) - r, y0 = Math.round(cy) - r;
		for (let y = 0; y < size; y++) {
			const sy = ((y0 + y) % n + n) % n;
			for (let x = 0; x < size; x++) {
				data[y * size + x] = world[sy * n + ((x0 + x) % n + n) % n];
			}
		}
		return { w: size, h: size, data };
	}
}
