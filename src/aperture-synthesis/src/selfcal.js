// selfcal.js — the real EHT-style reconstruction pipeline: phase-only self-calibration plus
// regularized positivity imaging, operating on STATION-RESOLVED visibilities (every datum keeps
// its antenna pair, scan time, night, and noise). This is the honest path from the network-
// calibrated M87 data (which images to scatter, because residual per-station phase errors put the
// flux in the wrong places) to a dark-centre ring — by SOLVING those phase errors instead of
// trusting them. It is the DIFMAP-style pipeline (CLEAN→self-cal loop) in miniature; here the
// imager is POCS (positivity + compact support + a smoothness regularizer) rather than CLEAN.
//
// Vis-row layout (data.vis[k]) matches tools/preprocess_eht_full.py:
//   [night, time(days), a1, a2, gridIdx, re, im, sigma]   a1/a2 = 0-based station indices.
import { fft2d, fftshift2d } from './fft.js';

// compactSupport — a centred-at-origin disk mask. The source is known to be compact (a few tens
// of µas), so flux outside this radius is unphysical; zeroing it each iteration is the support
// regularizer. Origin-referenced (radius measured with wraparound) to match the image layout.
export function compactSupport(n, radius) {
	const sup = new Float64Array(n * n);
	for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
		const dr = Math.min(r, n - r), dc = Math.min(c, n - c);
		sup[r * n + c] = Math.hypot(dr, dc) <= radius ? 1 : 0;
	}
	return sup;
}

// blur3 — one pass of a separable [1,2,1] kernel (≈ Gaussian σ≈0.7 px). Cheap stand-in for the
// entropy / total-variation regularizers a full RML imager uses to prefer smooth images to knotty
// ones. Blended in (not applied outright) so it nudges rather than dominates.
function blur3(src, n) {
	const t = new Float64Array(n * n), out = new Float64Array(n * n);
	for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
		const l = src[y * n + Math.max(0, x - 1)], c = src[y * n + x], r = src[y * n + Math.min(n - 1, x + 1)];
		t[y * n + x] = 0.25 * l + 0.5 * c + 0.25 * r;
	}
	for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
		const u = t[Math.max(0, y - 1) * n + x], c = t[y * n + x], d = t[Math.min(n - 1, y + 1) * n + x];
		out[y * n + x] = 0.25 * u + 0.5 * c + 0.25 * d;
	}
	return out;
}

// recenter — roll the image so its flux centroid sits at the origin. Self-cal cannot constrain
// ABSOLUTE position (a linear phase ramp across uv is a position shift it can't distinguish from
// calibration). Uses a CIRCULAR centroid because the FFT grid wraps around. CAUTION: opt-in only
// (default off in runSelfCal) — the brightness centroid of an ASYMMETRIC ring sits off its
// geometric centre (toward the bright arc), so centring on it drags the bright arc into the hole
// and fills it. Correct for symmetric sources; harmful for M87. A generous support tolerates the
// modest drift without this. Kept because it is the right tool for symmetric test sources.
export function recenter(x, n) {
	let scx = 0, ssx = 0, scy = 0, ssy = 0, tot = 0;
	for (let y = 0; y < n; y++) for (let c = 0; c < n; c++) {
		const w = x[y * n + c]; if (w <= 0) continue;
		const ax = 2 * Math.PI * c / n, ay = 2 * Math.PI * y / n;
		scx += w * Math.cos(ax); ssx += w * Math.sin(ax);
		scy += w * Math.cos(ay); ssy += w * Math.sin(ay); tot += w;
	}
	if (tot === 0) return x;
	const cx = Math.round(((Math.atan2(ssx, scx) / (2 * Math.PI)) * n + n)) % n;
	const cy = Math.round(((Math.atan2(ssy, scy) / (2 * Math.PI)) * n + n)) % n;
	if (cx === 0 && cy === 0) return x;
	const out = new Float64Array(n * n);
	for (let y = 0; y < n; y++) { const sy = ((y - cy) % n + n) % n;
		for (let c = 0; c < n; c++) { const sx = ((c - cx) % n + n) % n; out[sy * n + sx] = x[y * n + c]; } }
	return out;
}

// gridCorrected — weighted-average the gain-corrected visibilities onto a Hermitian grid.
// `corr` holds the corrected (re,im) interleaved per row. Returns {vr,vi,mask}.
export function gridCorrected(vis, corr, n) {
	const n2 = n * n;
	const ar = new Float64Array(n2), ai = new Float64Array(n2), aw = new Float64Array(n2);
	for (let k = 0; k < vis.length; k++) {
		// clamp the weight so a degenerate sigma≈0 can't make w=Infinity → NaN through the FFT
		// (defensive: the shipped data has sigma≥1e-3, but a future regen mustn't blank the panel).
		const idx = vis[k][4], w = 1 / Math.max(vis[k][7] * vis[k][7], 1e-12);
		ar[idx] += w * corr[2 * k]; ai[idx] += w * corr[2 * k + 1]; aw[idx] += w;
	}
	const vr = new Float64Array(n2), vi = new Float64Array(n2), mask = new Float64Array(n2);
	// Pass 1: place the MEASURED cells (weighted average). Pass 2: fill each cell's Hermitian
	// conjugate ONLY where it wasn't itself measured — measured data wins over a mirrored copy,
	// and a self-conjugate cell (DC / Nyquist, cj === idx) is never overwritten.
	for (let idx = 0; idx < n2; idx++) {
		if (aw[idx] === 0) continue;
		vr[idx] = ar[idx] / aw[idx]; vi[idx] = ai[idx] / aw[idx]; mask[idx] = 1;
	}
	for (let idx = 0; idx < n2; idx++) {
		if (aw[idx] === 0) continue;
		const ku = idx % n, kv = (idx / n) | 0, cj = ((n - kv) % n) * n + ((n - ku) % n);
		if (cj === idx || mask[cj]) continue;
		vr[cj] = vr[idx]; vi[cj] = -vi[idx]; mask[cj] = 1;
	}
	return { vr, vi, mask };
}

// imagePOCS — positivity + data-consistency + compact-support reconstruction, with an optional
// smoothness regularizer (blend each iterate toward a smoothed copy). smooth: 0 = pure POCS.
export function imagePOCS(vr, vi, mask, sup, n, iters, smooth = 0) {
	const n2 = n * n, x = new Float64Array(n2);
	const ar = Float64Array.from(vr), ai = Float64Array.from(vi);
	fft2d(ar, ai, n, true);
	for (let i = 0; i < n2; i++) x[i] = Math.max(0, ar[i]) * sup[i];
	for (let it = 0; it < iters; it++) {
		const br = Float64Array.from(x), bi = new Float64Array(n2);
		fft2d(br, bi, n, false);
		for (let i = 0; i < n2; i++) if (mask[i]) { br[i] = vr[i]; bi[i] = vi[i]; }
		fft2d(br, bi, n, true);
		for (let i = 0; i < n2; i++) x[i] = Math.max(0, br[i]) * sup[i];
		if (smooth > 0) { const sm = blur3(x, n); for (let i = 0; i < n2; i++) x[i] = (1 - smooth) * x[i] + smooth * sm[i]; }
	}
	return x;
}

// accumGain — one baseline's contribution to station s's gain update:  Σ w·Vo·g_other·conj(Mo),
// with Vo/Mo already oriented so the model reads Vo = g_s·conj(g_other)·Mo.
function accumGain(accRe, accIm, s, other, Vore, Voim, More, Moim, gr, gi, w) {
	const goRe = gr[other], goIm = gi[other];
	const pRe = Vore * goRe - Voim * goIm, pIm = Vore * goIm + Voim * goRe;   // Vo·g_other
	accRe[s] += w * (pRe * More + pIm * Moim);                                // ·conj(Mo)
	accIm[s] += w * (pIm * More - pRe * Moim);
}

// solveScanGains — Gauss-Seidel phase-only self-cal for one (night,scan) group, in place on
// gr/gi. Maximises alignment of measured V to the model under unit-modulus station gains, then
// references the phases to the most-observed station (removes the per-scan global-phase freedom).
export function solveScanGains(rows, vis, Mr, Mi, gr, gi, nStations, sweeps) {
	for (let s = 0; s < sweeps; s++) {
		const accRe = new Float64Array(nStations), accIm = new Float64Array(nStations);
		for (const k of rows) {
			const a1 = vis[k][2], a2 = vis[k][3], idx = vis[k][4], w = 1 / Math.max(vis[k][7] * vis[k][7], 1e-12);
			const vre = vis[k][5], vim = vis[k][6], Mre = Mr[idx], Mim = Mi[idx];
			accumGain(accRe, accIm, a1, a2, vre, vim, Mre, Mim, gr, gi, w);       // station a1
			accumGain(accRe, accIm, a2, a1, vre, -vim, Mre, -Mim, gr, gi, w);     // station a2 (conj)
		}
		for (let st = 0; st < nStations; st++) {
			const mag = Math.hypot(accRe[st], accIm[st]);
			if (mag > 1e-12) { gr[st] = accRe[st] / mag; gi[st] = accIm[st] / mag; }
		}
	}
	const cnt = new Int32Array(nStations);
	for (const k of rows) { cnt[vis[k][2]]++; cnt[vis[k][3]]++; }
	let ref = 0; for (let s = 1; s < nStations; s++) if (cnt[s] > cnt[ref]) ref = s;
	const rmag = Math.hypot(gr[ref], gi[ref]) || 1, cr = gr[ref] / rmag, ci = -gi[ref] / rmag;
	for (let s = 0; s < nStations; s++) { const a = gr[s], b = gi[s]; gr[s] = a * cr - b * ci; gi[s] = a * ci + b * cr; }
}

// groupByScan — map each vis row to a (night,scan) bucket of row indices. scanBin in days.
function groupByScan(vis, scanBin) {
	const groups = new Map();
	for (let i = 0; i < vis.length; i++) {
		const key = vis[i][0] * 100000 + Math.floor(vis[i][1] / scanBin);
		let g = groups.get(key); if (!g) { g = []; groups.set(key, g); } g.push(i);
	}
	return groups;
}

// restoringBeam — separable Gaussian blur for DISPLAY. Standard EHT practice: published images are
// restored to the array's nominal resolution because the super-resolution knots aren't all
// trustworthy. Here it also connects the recovered ring's arcs into a cleaner loop.
export function restoringBeam(src, n, sigma) {
	const r = Math.max(1, Math.ceil(3 * sigma)), ker = new Float64Array(2 * r + 1);
	let s = 0; for (let i = -r; i <= r; i++) { const w = Math.exp(-(i * i) / (2 * sigma * sigma)); ker[i + r] = w; s += w; }
	for (let i = 0; i < ker.length; i++) ker[i] /= s;
	const t = new Float64Array(n * n), out = new Float64Array(n * n);
	for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { let a = 0;
		for (let i = -r; i <= r; i++) { const xx = Math.min(n - 1, Math.max(0, x + i)); a += src[y * n + xx] * ker[i + r]; } t[y * n + x] = a; }
	for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { let a = 0;
		for (let i = -r; i <= r; i++) { const yy = Math.min(n - 1, Math.max(0, y + i)); a += t[yy * n + x] * ker[i + r]; } out[y * n + x] = a; }
	return out;
}

// makeSelfCalSolver — a RESUMABLE self-cal loop. Each step() runs one outer iteration (solve all
// scan gains against the current model, apply, re-image) and returns the updated origin-referenced
// image, so the UI can animate the ring emerging. The starting image is the network-calibrated data
// imaged directly (its partially-correct phases bootstrap the first gain solve).
export function makeSelfCalSolver(data, opts = {}) {
	const n = data.n, n2 = n * n, vis = data.vis, m = vis.length, nSt = data.stations.length;
	const scanBin = opts.scanBin ?? 0.0015, imgIters = opts.imgIters ?? 150, gsSweeps = opts.gsSweeps ?? 5;
	const sup = compactSupport(n, opts.supportR ?? 16), smooth = opts.smooth ?? 0.12;
	const place = (img) => (opts.recenter ?? false) ? recenter(img, n) : img;  // off: harmful on asymmetric sources
	const groups = groupByScan(vis, scanBin), gains = new Map();
	for (const key of groups.keys()) gains.set(key, { gr: new Float64Array(nSt).fill(1), gi: new Float64Array(nSt) });
	const corr = new Float64Array(2 * m);
	const applyGains = () => {
		for (const [key, rows] of groups) { const { gr, gi } = gains.get(key);
			for (const k of rows) { const a1 = vis[k][2], a2 = vis[k][3], vre = vis[k][5], vim = vis[k][6];
				const cr = gr[a1] * gr[a2] + gi[a1] * gi[a2], ci = gr[a1] * gi[a2] - gi[a1] * gr[a2];
				corr[2 * k] = vre * cr - vim * ci; corr[2 * k + 1] = vre * ci + vim * cr; } }
	};
	for (let k = 0; k < m; k++) { corr[2 * k] = vis[k][5]; corr[2 * k + 1] = vis[k][6]; }
	let g = gridCorrected(vis, corr, n);
	let x = place(imagePOCS(g.vr, g.vi, g.mask, sup, n, imgIters, smooth));
	// step(iters) — one outer iteration; `iters` overrides the imaging budget for THIS step (the UI
	// ramps it low→high across the animation: cheap rough frames early, a high-quality solve late
	// once the gains have converged). Defaults to the solver's imgIters.
	const step = (iters = imgIters) => {
		const Mr = Float64Array.from(x), Mi = new Float64Array(n2);
		fft2d(Mr, Mi, n, false);
		for (const [key, rows] of groups) solveScanGains(rows, vis, Mr, Mi, gains.get(key).gr, gains.get(key).gi, nSt, gsSweeps);
		applyGains();
		g = gridCorrected(vis, corr, n);
		x = place(imagePOCS(g.vr, g.vi, g.mask, sup, n, iters, smooth));
		return x;
	};
	// refine — re-image the CURRENT gain-corrected data at a higher iteration count, without
	// touching the gains. Lets the UI animate cheap (low-iter) frames, then do one crisp final
	// pass — avoiding a ~130 ms-per-frame main-thread block across the whole animation.
	const refine = (iters) => { x = place(imagePOCS(g.vr, g.vi, g.mask, sup, n, iters, smooth)); return x; };
	return { step, refine, n, get image() { return x; }, get shifted() { return fftshift2d(x, n); } };
}

// runSelfCal — convenience wrapper: run the solver to completion. Returns { image, shifted,
// history } where history is the per-iteration L2 image change (a convergence trace).
export function runSelfCal(data, opts = {}) {
	const solver = makeSelfCalSolver(data, opts), outerIters = opts.outerIters ?? 12, history = [];
	for (let o = 0; o < outerIters; o++) {
		const prev = Float64Array.from(solver.image); solver.step();
		const img = solver.image; let d = 0; for (let i = 0; i < img.length; i++) d += (img[i] - prev[i]) ** 2;
		history.push(Math.sqrt(d));
	}
	return { image: solver.image, shifted: solver.shifted, history };
}
