// fft.js — complex Fast Fourier Transform, hand-rolled, zero dependencies.
//
// WHY hand-rolled instead of a library: this project teaches the physics of
// aperture synthesis, and the FFT *is* that physics (an interferometer measures
// the Fourier transform of the sky — van Cittert–Zernike). Keeping the transform
// in readable, commented code means a reader can see the mechanism instead of
// trusting a black box, and it keeps the page dependency-free (loads as a plain
// ES module, no build step).
//
// Convention: forward transform uses the exp(-2πi·kn/N) kernel; the inverse uses
// +2πi and divides by N. Data is passed as two parallel Float64Arrays (real and
// imaginary parts) and transformed IN PLACE — no per-call allocation in the hot
// path, which matters because we re-transform on every drag/animation frame.

// fft1d — in-place iterative radix-2 Cooley–Tukey FFT of one complex vector.
//   re, im : parallel Float64Arrays holding the real/imaginary parts (length N).
//   inverse: false = forward transform, true = inverse (adds the 1/N scaling).
// Mutates re/im in place. Length MUST be a power of two (radix-2 requirement);
// we check and throw rather than silently produce garbage (Power-of-Ten rule 5).
export function fft1d(re, im, inverse) {
	const n = re.length;
	if ((n & (n - 1)) !== 0 || n === 0) {
		throw new Error(`fft1d: length ${n} is not a power of two`);
	}

	// Step 1 — bit-reversal permutation. Decimation-in-time reorders the input so
	// the butterfly stages below can run sequentially in place. Each index is
	// swapped with the value at its bit-reversed position. `j` is maintained as
	// the running bit-reversal of `i` without recomputing it from scratch.
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit; // carry down through set bits
		j ^= bit;
		if (i < j) {
			const tr = re[i]; re[i] = re[j]; re[j] = tr;
			const ti = im[i]; im[i] = im[j]; im[j] = ti;
		}
	}

	// Step 2 — butterfly stages, combining sub-transforms of size 2, 4, 8 … N.
	// `len` is the current sub-transform size; `w` is the principal twiddle factor
	// exp(±2πi/len) which we multiply up across the half-block instead of calling
	// cos/sin per element (cheaper, and keeps the inner loop tight).
	for (let len = 2; len <= n; len <<= 1) {
		const ang = (inverse ? 2 : -2) * Math.PI / len;
		const wRe = Math.cos(ang), wIm = Math.sin(ang);
		const half = len >> 1;
		for (let i = 0; i < n; i += len) {
			let curRe = 1, curIm = 0; // twiddle accumulator, starts at exp(0)=1
			for (let k = 0; k < half; k++) {
				const p = i + k, q = p + half;
				// b = twiddle · lower-half element
				const bRe = re[q] * curRe - im[q] * curIm;
				const bIm = re[q] * curIm + im[q] * curRe;
				const aRe = re[p], aIm = im[p];
				re[p] = aRe + bRe; im[p] = aIm + bIm;
				re[q] = aRe - bRe; im[q] = aIm - bIm;
				// advance twiddle: cur *= w
				const nRe = curRe * wRe - curIm * wIm;
				curIm = curRe * wIm + curIm * wRe;
				curRe = nRe;
			}
		}
	}

	// Step 3 — inverse normalization. Forward leaves data unscaled; inverse divides
	// by N so that ifft(fft(x)) == x.
	if (inverse) {
		for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
	}
}

// fft2d — 2D FFT of a square N×N complex image by the row-column algorithm:
// transform every row, then every column. A 2D DFT is separable, so this gives
// the exact 2D transform.
//   re, im : parallel Float64Arrays of length N*N, row-major (index = row*N + col).
//   n      : side length N (power of two).
//   inverse: false = forward, true = inverse.
// Each 1D inverse divides by N, so a 2D inverse (rows then cols) divides by N²
// total — exactly the 2D normalization. We reuse one pair of length-N scratch
// buffers for all rows and columns to avoid per-line allocation.
export function fft2d(re, im, n, inverse) {
	if (re.length !== n * n || im.length !== n * n) {
		throw new Error(`fft2d: expected ${n * n} samples, got ${re.length}/${im.length}`);
	}
	const lineRe = new Float64Array(n), lineIm = new Float64Array(n);

	for (let r = 0; r < n; r++) {             // rows
		const off = r * n;
		for (let c = 0; c < n; c++) { lineRe[c] = re[off + c]; lineIm[c] = im[off + c]; }
		fft1d(lineRe, lineIm, inverse);
		for (let c = 0; c < n; c++) { re[off + c] = lineRe[c]; im[off + c] = lineIm[c]; }
	}
	for (let c = 0; c < n; c++) {             // columns
		for (let r = 0; r < n; r++) { lineRe[r] = re[r * n + c]; lineIm[r] = im[r * n + c]; }
		fft1d(lineRe, lineIm, inverse);
		for (let r = 0; r < n; r++) { re[r * n + c] = lineRe[r]; im[r * n + c] = lineIm[r]; }
	}
}

// fftshift2d — swap diagonal quadrants so the zero-frequency (DC) component moves
// from the array corner (where FFT output places it) to the array center (where a
// human expects to see it). Used only for DISPLAY of the uv-plane and dirty beam,
// never in the compute path. Returns a new shifted Float64Array; input untouched.
//   src : Float64Array length n*n, row-major. n must be even.
export function fftshift2d(src, n) {
	if (src.length !== n * n) throw new Error(`fftshift2d: expected ${n * n}, got ${src.length}`);
	const out = new Float64Array(n * n);
	const h = n >> 1;
	for (let r = 0; r < n; r++) {
		const sr = (r + h) % n;
		for (let c = 0; c < n; c++) {
			out[r * n + c] = src[sr * n + ((c + h) % n)];
		}
	}
	return out;
}
