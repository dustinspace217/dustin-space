// main.js — application bootstrap and the single recompute path.
//
// Holds the scene state, runs the physics→imaging→render pipeline whenever state
// changes (update()), and hands the controls off to ui.js. There is exactly ONE
// update() so every interaction (drag, slider, preset) flows through the same
// recompute — no panel can drift out of sync with another.

import { N, LAMBDA, UV_MAX, MAP_EXTENT_M, DEFAULTS } from './config.js';
import { makeSky } from './sky.js';
import { arrayPreset } from './arrays.js';
import { sampleUv } from './physics.js';
import { gridSampling, dirtyImageAndBeam, dirtyFromVisibilities, visibilityGridFromCells, synthGrid } from './imaging.js';
import { hogbomClean } from './clean.js';
import { makePositivitySolver } from './reconstruct.js';
import { fft2d, fftshift2d } from './fft.js';
import { renderField, renderUv, renderArrayMap, INFERNO, GRAY } from './render.js';
import { initUI } from './ui.js';

const $ = (id) => document.getElementById(id);

// The most recent simulation reconstruction inputs, stashed so the method buttons can
// run CLEAN on demand without recomputing the pipeline. Refreshed every paint.
let lastDirty = null, lastBeam = null;

// animatePositivity — step a resumable positivity solver a few iterations per animation
// frame, repainting each step, so the user WATCHES the data converge toward the image
// (vs CLEAN/dirty, which are instant). `channel` is a {h} holder so the animation can be
// cancelled independently. Calls onFrame(image) each step, onDone at the end. Used by the
// capstone (the simulation keeps Dirty/CLEAN — positivity needs the right coverage+scale
// to beat CLEAN, which only happens on the EHT-scale data, not the sim's large ring).
function animatePositivity(channel, solver, totalIters, onFrame, onDone) {
	if (channel.h) cancelAnimationFrame(channel.h);
	let done = 0;
	onFrame(solver.image); // the starting (positive dirty) state
	const tick = () => {
		solver.step(Math.min(8, totalIters - done)); done = Math.min(totalIters, done + 8);
		onFrame(solver.image);
		if (done < totalIters) { channel.h = requestAnimationFrame(tick); }
		else { channel.h = 0; if (onDone) onDone(); }
	};
	channel.h = requestAnimationFrame(tick);
}

// gaussianField — a length-`size` array of standard-normal samples (Box–Muller). Used
// once at load to make a FIXED thermal-noise pattern: only its amplitude scales with
// the noise slider, so the noise doesn't reshuffle on every frame (which would flicker).
function gaussianField(size) {
	const a = new Float64Array(size);
	for (let i = 0; i < size; i++) {
		const u1 = Math.random() || 1e-12, u2 = Math.random();
		a[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
	}
	return a;
}
const noiseFieldRe = gaussianField(N * N);
const noiseFieldIm = gaussianField(N * N);

// Initial scene: clone the default array's antennas (clone so dragging mutates our
// copy, not the shared preset object — Power-of-Ten rule 6, smallest scope / no
// shared mutable state).
const preset0 = arrayPreset(DEFAULTS.array);
const state = {
	sky: DEFAULTS.sky,
	arrayName: DEFAULTS.array,
	antennas: preset0.antennas.map((a) => ({ e: a.e, n: a.n })),
	latDeg: preset0.latDeg,
	decDeg: DEFAULTS.decDeg,
	haStartDeg: DEFAULTS.haStartDeg,
	haEndDeg: DEFAULTS.haEndDeg,
	haSteps: DEFAULTS.haSteps,
	noiseLevel: DEFAULTS.noiseLevel,
	dragIndex: -1, // index of the dish being dragged, or -1
};

const canvases = {
	array: $('canvas-array'), uv: $('canvas-uv'),
	beam: $('canvas-beam'), dirty: $('canvas-dirty'), sky: $('canvas-sky'),
};

// update — recompute the whole pipeline from `state` and repaint every panel.
// Cheap enough (one 128² FFT pair) to run on every pointer move.
function update() {
	const skyImg = makeSky(state.sky, N);
	const points = sampleUv(state.antennas, {
		latDeg: state.latDeg, decDeg: state.decDeg, lambda: LAMBDA,
		haStartDeg: state.haStartDeg, haEndDeg: state.haEndDeg, haSteps: state.haSteps,
	});
	const { mask, filled } = gridSampling(points, N, UV_MAX);
	const { dirty, beam } = dirtyImageAndBeam(skyImg, mask, N,
		{ level: state.noiseLevel, fieldRe: noiseFieldRe, fieldIm: noiseFieldIm });

	renderField(canvases.sky, skyImg, N, INFERNO, true);
	renderUv(canvases.uv, points, UV_MAX);
	renderField(canvases.beam, beam, N, GRAY, true);
	renderField(canvases.dirty, dirty, N, INFERNO, true);
	renderArrayMap(canvases.array, state.antennas, MAP_EXTENT_M, state.dragIndex);

	// Panel 05 shows the live dirty image; stash the inputs the method buttons need and
	// reset the method selector to "Dirty", since any scene change makes a previous
	// reconstruction stale.
	lastDirty = dirty; lastBeam = beam;
	resetSimMethod();

	const m = state.antennas.length;
	const baselines = (m * (m - 1)) / 2;
	$('stat-dishes').textContent = m;
	$('stat-baselines').textContent = baselines;
	$('stat-samples').textContent = filled;
	updateAriaLabels(m, baselines, filled);
}

// updateAriaLabels — keep the canvases' text alternatives in sync with live state,
// so a screen-reader user gets the current numbers, not just static prose. Paired
// with the aria-live readout region, this makes the visual-only tool legible.
function updateAriaLabels(m, baselines, filled) {
	const skyName = state.sky;
	canvases.array.setAttribute('aria-label',
		`Antenna array map: ${m} dishes on the ground, forming ${baselines} baselines. Drag to reposition.`);
	canvases.uv.setAttribute('aria-label',
		`UV-coverage plot: ${filled} distinct spatial frequencies sampled across the plane.`);
	canvases.sky.setAttribute('aria-label', `True sky: a ${skyName} target — the ground truth to reconstruct.`);
	canvases.beam.setAttribute('aria-label', 'Dirty beam: the array point-spread function for the current coverage.');
	canvases.dirty.setAttribute('aria-label', `Reconstruction of the ${skyName} target from the sampled coverage.`);
	$('live-status').textContent = `${m} dishes, ${baselines} baselines, ${filled} uv cells.`;
}

// resetSimMethod — return panel 05 to its "showing the dirty image" baseline: stop any
// running animation and re-select Dirty. Called from update() so any scene change reverts
// a stale reconstruction (update() has already repainted the live dirty image).
function resetSimMethod() {
	document.querySelectorAll('[data-sim-method]').forEach((b) =>
		b.setAttribute('aria-pressed', String(b.dataset.simMethod === 'dirty')));
	const hint = $('recon-hint');
	if (hint) hint.textContent = 'the dirty image';
}

// wireSimMethods — the panel-05 reconstruction-method selector: Dirty / CLEAN. Each runs
// ONLY on click (never per drag-frame), reading the stashed dirty/beam.
function wireSimMethods() {
	const btns = [...document.querySelectorAll('[data-sim-method]')];
	if (!btns.length) return;
	const hint = $('recon-hint');
	const setActive = (m) => btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.simMethod === m)));
	btns.forEach((b) => b.addEventListener('click', () => {
		if (!lastDirty) return;
		const m = b.dataset.simMethod;
		setActive(m);
		if (m === 'dirty') {
			renderField(canvases.dirty, lastDirty, N, INFERNO, true);
			hint.textContent = 'the dirty image';
		} else {
			const { cleaned, iterations } = hogbomClean(lastDirty, lastBeam, N, { gain: 0.1, maxIter: 300, thresholdFrac: 0.03 });
			renderField(canvases.dirty, cleaned, N, INFERNO, true);
			hint.textContent = `CLEANed · ${iterations} iters`;
		}
	}));
}

// cropCentre — extract the central m×m of an n×n field. Used to display the EHT image
// at the source's actual field-of-view (a few hundred µas) instead of the whole grid —
// standard radio-image practice (the same data, zoomed to where the emission is).
function cropCentre(arr, n, m) {
	const out = new Float64Array(m * m);
	const off = (n - m) >> 1;
	for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) out[r * m + c] = arr[(r + off) * n + (c + off)];
	return out;
}
// Central crop side for the EHT image panels. On the beam-oversampled grid this spans
// ~250 µas — tight enough to fill the panel with M87*'s emission, loose enough to still
// show the sparse-coverage artifacts that are the honest lesson.
const EHT_CROP = 56;

// dirtyBeamFromGrid — dirty image + beam (display layout, fftshift-ed) from a measured
// visibility grid. Shared by the real and synthetic capstone sources.
function dirtyBeamFromGrid(vr, vi, mask, n) {
	const ar = Float64Array.from(vr), ai = Float64Array.from(vi); fft2d(ar, ai, n, true);
	const br = Float64Array.from(mask), bi = new Float64Array(n * n); fft2d(br, bi, n, true);
	return { dirty: fftshift2d(ar, n), beam: fftshift2d(br, n) };
}

// wireEHTCapstone — lazy-load the real EHT M87* visibilities on demand and run them
// through the same dirty-image + CLEAN pipeline. Kept entirely separate from the
// simulation state so it can't perturb it.
function wireEHTCapstone() {
	const loadBtn = $('eht-load');
	if (!loadBtn) return; // capstone markup absent ⇒ skip without breaking the simulation
	const cv = { uv: $('canvas-eht-uv'), beam: $('canvas-eht-beam'), dirty: $('canvas-eht-dirty') };
	let eht = null; // { dirty, beam } once loaded

	loadBtn.addEventListener('click', async () => {
		loadBtn.disabled = true; loadBtn.textContent = 'Loading…';
		try {
			const res = await fetch('data/eht-m87.json');
			if (!res.ok) throw new Error(`HTTP ${res.status} fetching eht-m87.json`);
			const data = await res.json();
			const n = data.n;
			const { vr, vi, mask, filled } = visibilityGridFromCells(data.cells, n);
			// Build the real source plus three synthetic test sources through the SAME coverage,
			// so the data-source toggle can ask "can this coverage image a known ring?".
			const fromGrid = (gvr, gvi) => ({ vr: gvr, vi: gvi, mask, ...dirtyBeamFromGrid(gvr, gvi, mask, n) });
			const synth = (kind) => { const g = synthGrid(mask, n, kind); return fromGrid(g.vr, g.vi); };
			eht = { n, source: 'real', sources: { real: fromGrid(vr, vi), ring: synth('ring'), point: synth('point'), disk: synth('disk') } };
			// coverage: convert the measured cells back to (u,v) in cell units, reuse renderUv.
			// Auto-fit the display to the coverage extent (the cells cluster near grid-centre
			// because the image is beam-oversampled). ext starts at 1 as a floor so an all-DC
			// dataset can't collapse the zoom to zero.
			const half = data.n >> 1;
			let ext = 1;
			const pts = [];
			for (let k = 0; k < data.cells.length; k++) {
				const idx = data.cells[k][0];
				const c = idx % data.n, r = (idx / data.n) | 0;
				const u = c < half ? c : c - data.n, v = r < half ? r : r - data.n;
				if (Math.abs(u) > ext) ext = Math.abs(u);
				if (Math.abs(v) > ext) ext = Math.abs(v);
				pts.push({ u, v });
			}
			renderUv(cv.uv, pts, ext * 1.1);
			renderField(cv.beam, cropCentre(eht.sources.real.beam, eht.n, EHT_CROP), EHT_CROP, GRAY, true);
			renderField(cv.dirty, cropCentre(eht.sources.real.dirty, eht.n, EHT_CROP), EHT_CROP, INFERNO, true);
			$('eht-uv-hint').textContent = `${filled} cells · ${data.nVisibilities.toLocaleString()} vis`;
			$('eht-stage').hidden = false;
			loadBtn.hidden = true;
		} catch (e) {
			console.error('EHT capstone load failed:', e);
			loadBtn.disabled = false; loadBtn.textContent = '▼ Load failed — retry';
		}
	});

	// Capstone controls: a DATA-source selector (real M87* vs known synthetic shapes through
	// the SAME coverage — the validation) and a reconstruction-METHOD selector. Own animation
	// channel so it doesn't fight the simulation's.
	const ehtAnim = { h: 0 };
	const ehtHint = $('eht-recon-hint');
	const cur = () => eht.sources[eht.source];
	const showCrop = (img) => renderField(cv.dirty, cropCentre(img, eht.n, EHT_CROP), EHT_CROP, INFERNO, true);
	const setPressed = (sel, key, val) => document.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[key] === val)));

	// runMethod — apply a reconstruction method to the CURRENT data source and paint R3.
	const runMethod = (m) => {
		if (ehtAnim.h) { cancelAnimationFrame(ehtAnim.h); ehtAnim.h = 0; }
		setPressed('[data-eht-method]', 'ehtMethod', m);
		const s = cur();
		if (m === 'dirty') {
			showCrop(s.dirty); ehtHint.textContent = 'the dirty image';
		} else if (m === 'clean') {
			// Conservative CLEAN — stop early so it doesn't dig spurious structure from sidelobes.
			const { cleaned, iterations } = hogbomClean(s.dirty, s.beam, eht.n, { gain: 0.1, maxIter: 120, thresholdFrac: 0.06 });
			showCrop(cleaned); ehtHint.textContent = `CLEANed · ${iterations} iters`;
		} else { // positivity — animated; visibilities are origin-referenced, so shift to display
			const solver = makePositivitySolver(s.vr, s.vi, s.mask, eht.n);
			ehtHint.textContent = 'Positivity · converging…';
			animatePositivity(ehtAnim, solver, 600, (img) => showCrop(fftshift2d(img, eht.n)),
				() => { ehtHint.textContent = eht.source === 'real' ? 'Positivity · still scatters — see caption' : 'Positivity · recovered'; });
		}
	};

	document.querySelectorAll('[data-eht-method]').forEach((b) =>
		b.addEventListener('click', () => { if (eht) runMethod(b.dataset.ehtMethod); }));
	document.querySelectorAll('[data-eht-source]').forEach((b) =>
		b.addEventListener('click', () => {
			if (!eht) return;
			eht.source = b.dataset.ehtSource;
			setPressed('[data-eht-source]', 'ehtSource', eht.source);
			// Re-run the CURRENT method on the new source, so comparing (e.g.) Positivity across
			// data sources — the caption's "feed a Ring through this coverage and run Positivity"
			// workflow — doesn't force re-clicking the method each time.
			const m = document.querySelector('[data-eht-method][aria-pressed="true"]')?.dataset.ehtMethod || 'dirty';
			runMethod(m);
		}));
}

// Wire controls (ui.js mutates `state` and calls `update`), then do the first paint.
initUI(state, update, canvases.array);
wireSimMethods();
wireEHTCapstone();
update();
