// Hand-rolled radix-2 FFT and the cyclic convolution built on it.
//
// Why FFT instead of direct convolution on the CPU: a radius-13 kernel is a
// 27x27 stencil = 729 multiply-adds per cell. On a 128x128 world that's ~12M
// ops per step; the discovery search runs hundreds of steps across thousands
// of parameter combinations. FFT convolution costs O(n^2 log n) per step
// regardless of kernel size, ~10x faster here, and the torus wraparound falls
// out for free (FFT convolution IS cyclic). The GPU engine keeps direct
// convolution (trivially parallel there); this module is CPU-only territory.
//
// Why hand-rolled instead of a library: zero-dependency is a Corner
// convention (see PLAN.md), and the aperture-synthesis explorable set the
// precedent — readable FFTs beat black-box ones for a page whose point is
// showing the machinery.

// In-place iterative radix-2 Cooley-Tukey FFT.
// Receives: re, im — Float64Arrays of length n (modified in place),
//           n      — power of 2,
//           inverse — false for forward, true for inverse (unscaled — the
//                     1/n scaling is applied by ifft2d, once, not per axis).
// Returns: nothing (results live in re/im).
export function fft1d(re, im, n, inverse) {
	// Own power-of-2 guard: fft1d is exported and used directly by tests and
	// the parity probe, not only through CpuSim (which already checks). A
	// non-power-of-2 length would silently produce garbage from the butterfly
	// passes, so refuse it at the boundary (Power-of-Ten rule 5).
	if ((n & (n - 1)) !== 0) throw new Error(`fft1d: length ${n} is not a power of 2`);
	// --- bit-reversal permutation -------------------------------------
	// Standard iterative-FFT prologue: reorder inputs so the butterfly
	// passes below can work on adjacent pairs. j tracks the bit-reversed
	// counterpart of i via the "add carry from the top" trick.
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			let t = re[i]; re[i] = re[j]; re[j] = t;
			t = im[i]; im[i] = im[j]; im[j] = t;
		}
	}
	// --- butterfly passes ----------------------------------------------
	// len doubles each pass: log2(n) passes total (bounded loop: len <= n).
	for (let len = 2; len <= n; len <<= 1) {
		const ang = (inverse ? 2 : -2) * Math.PI / len;
		const wRe = Math.cos(ang), wIm = Math.sin(ang);
		for (let i = 0; i < n; i += len) {
			let curRe = 1, curIm = 0;         // running twiddle factor w^k
			const half = len >> 1;
			for (let k = 0; k < half; k++) {
				const a = i + k, b = i + k + half;
				const tRe = re[b] * curRe - im[b] * curIm;
				const tIm = re[b] * curIm + im[b] * curRe;
				re[b] = re[a] - tRe; im[b] = im[a] - tIm;
				re[a] += tRe;        im[a] += tIm;
				// Advance the twiddle by one step (complex multiply by w).
				const nRe = curRe * wRe - curIm * wIm;
				curIm = curRe * wIm + curIm * wRe;
				curRe = nRe;
			}
		}
	}
}

// 2D FFT: transform every row, then every column. Works in place on
// row-major Float64Array(n*n). Column passes copy into scratch rows first —
// strided in-place FFTs thrash the cache and complicate the code for no win
// at n=128/256.
//
// Module-level scratch buffers, grown on demand and reused forever after:
// the search calls this millions of times and per-call allocation would make
// GC the bottleneck (and violates the bounded-memory rule — this caps
// allocation at one n-length pair total). Single-threaded per worker, so
// module-level state is safe here.
let scratchRe = new Float64Array(0);
let scratchIm = new Float64Array(0);

// Convolution work buffers for cyclicConvolve2d's field spectrum, grown on
// demand to n*n and reused forever after — same bounded-memory rationale as
// scratchRe/scratchIm above, but full-field sized (these hold the entire
// transformed field, not one row/column). Before this existed, every call
// allocated two fresh n*n Float64Arrays; the discovery search steps millions
// of times, so that allocation dominated GC. Single-threaded per worker, so
// module-level reuse is safe — see the reuse invariant on the return, below.
let convRe = new Float64Array(0);
let convIm = new Float64Array(0);

function fft2dPass(re, im, n, inverse) {
	if (scratchRe.length < n) {
		scratchRe = new Float64Array(n);
		scratchIm = new Float64Array(n);
	}
	// Rows: each row is contiguous — transform directly via subarray views.
	for (let y = 0; y < n; y++) {
		fft1d(re.subarray(y * n, y * n + n), im.subarray(y * n, y * n + n), n, inverse);
	}
	// Columns: gather -> transform -> scatter.
	for (let x = 0; x < n; x++) {
		for (let y = 0; y < n; y++) {
			scratchRe[y] = re[y * n + x];
			scratchIm[y] = im[y * n + x];
		}
		fft1d(scratchRe, scratchIm, n, inverse);
		for (let y = 0; y < n; y++) {
			re[y * n + x] = scratchRe[y];
			im[y * n + x] = scratchIm[y];
		}
	}
}

// Forward 2D FFT (in place, unscaled).
export function fft2d(re, im, n) { fft2dPass(re, im, n, false); }

// Inverse 2D FFT (in place), including the 1/n^2 normalization so that
// ifft2d(fft2d(x)) === x.
export function ifft2d(re, im, n) {
	fft2dPass(re, im, n, true);
	const inv = 1 / (n * n);
	for (let i = 0; i < n * n; i++) { re[i] *= inv; im[i] *= inv; }
}

// Cyclic 2D convolution of a real field with a small kernel stencil.
// Receives: field — Float64Array(n*n) row-major real values,
//           n     — world size (power of 2),
//           kernel — { size, weights } from buildKernel() (size = 2R+1).
// Returns: NEW Float64Array(n*n) = (kernel ∗ field) with torus wraparound.
//
// The kernel is embedded into an n×n grid CENTERED AT THE ORIGIN with
// negative offsets wrapped to the far edges — that's what makes the
// convolution shift-free (a delta at (x,y) yields the kernel centered at
// (x,y), verified by test). The kernel's transform is cached per kernel
// OBJECT (WeakMap keyed on identity) because the search steps the SAME
// kernel thousands of times. Identity, not a content fingerprint: a partial
// fingerprint can collide between two kernels that share a few weights, and
// a colliding cache would silently convolve with the WRONG spectrum — the
// nastiest possible failure mode. buildKernel() returns a fresh object per
// kernel, so identity is exact; WeakMap entries die with their kernels
// (bounded memory for free).
const kernelSpectra = new WeakMap();  // kernel -> { n, re, im }
export function cyclicConvolve2d(field, n, kernel) {
	let spec = kernelSpectra.get(kernel);
	if (!spec || spec.n !== n) {
		const kre = new Float64Array(n * n);
		const kim = new Float64Array(n * n);
		const R = (kernel.size - 1) / 2;
		for (let dy = -R; dy <= R; dy++) {
			for (let dx = -R; dx <= R; dx++) {
				const w = kernel.weights[(dy + R) * kernel.size + (dx + R)];
				if (w === 0) continue;
				kre[((dy + n) % n) * n + ((dx + n) % n)] = w;
			}
		}
		fft2d(kre, kim, n);
		spec = { n, re: kre, im: kim };
		kernelSpectra.set(kernel, spec);
	}
	// Reuse the module-level work buffers instead of allocating per call: copy
	// the field into convRe and zero convIm, then transform/multiply/inverse in
	// place. Grow-on-demand keeps them sized to the largest n seen (they never
	// shrink — the search runs one fixed n, and mixed-n test runs just keep the
	// max). This is what makes sim.js's "step() never allocates beyond the FFT's
	// internal fixed scratch" comment true.
	if (convRe.length < n * n) {
		convRe = new Float64Array(n * n);
		convIm = new Float64Array(n * n);
	}
	const re = convRe, im = convIm;
	re.set(field);        // copy the real field in (field is length n*n)
	im.fill(0);           // clear the imaginary part (and any stale tail)
	fft2d(re, im, n);
	// Pointwise complex multiply with the kernel spectrum.
	const kre = spec.re, kim = spec.im;
	for (let i = 0; i < n * n; i++) {
		const a = re[i], b = im[i];
		re[i] = a * kre[i] - b * kim[i];
		im[i] = a * kim[i] + b * kre[i];
	}
	ifft2d(re, im, n);
	// Return a view over exactly the n*n result. INVARIANT: the caller
	// (sim.step) must consume this fully before the next cyclicConvolve2d call,
	// because the next call overwrites convRe in place — same single-consumer
	// contract the scratch buffers already rely on, safe because each worker is
	// single-threaded. A subarray (not the raw buffer) keeps the returned
	// length exactly n*n even when convRe was grown larger by an earlier bigger n.
	return convRe.subarray(0, n * n);
}
