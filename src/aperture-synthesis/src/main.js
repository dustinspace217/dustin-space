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
import { gridSampling, dirtyImageAndBeam, dirtyFromVisibilities } from './imaging.js';
import { hogbomClean } from './clean.js';
import { renderField, renderUv, renderArrayMap, INFERNO, GRAY } from './render.js';
import { initUI } from './ui.js';

const $ = (id) => document.getElementById(id);

// The most recent dirty image + beam, stashed so the "CLEAN" button can deconvolve
// on demand without recomputing the pipeline. update() refreshes these every paint.
let lastDirty = null, lastBeam = null;

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

	// The reconstruction now shows the live dirty image; stash it for CLEAN and reset
	// the CLEAN toggle, since any scene change makes a previous deconvolution stale.
	lastDirty = dirty; lastBeam = beam;
	resetCleanToggle();

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

// resetCleanToggle — return panel 05 to its "showing the dirty image" baseline. Called
// from update() so any interaction reverts a stale CLEAN view and re-arms the button.
function resetCleanToggle() {
	const btn = $('clean-btn');
	if (btn) { btn.setAttribute('aria-pressed', 'false'); btn.textContent = '✦ CLEAN it up'; }
	const hint = $('recon-hint');
	if (hint) hint.textContent = 'the dirty image';
}

// wireCleanButton — toggle panel 05 between the raw dirty image and the Högbom-CLEANed
// reconstruction. CLEAN runs ONLY on click (never per drag-frame), reading the stashed
// dirty/beam — so it never taxes the interactive path.
function wireCleanButton() {
	const btn = $('clean-btn');
	if (!btn) return;
	btn.addEventListener('click', () => {
		if (!lastDirty || !lastBeam) return;
		const showingClean = btn.getAttribute('aria-pressed') === 'true';
		const hint = $('recon-hint');
		if (showingClean) {                 // toggle back to the dirty image
			renderField(canvases.dirty, lastDirty, N, INFERNO, true);
			btn.setAttribute('aria-pressed', 'false');
			btn.textContent = '✦ CLEAN it up';
			if (hint) hint.textContent = 'the dirty image';
		} else {                             // deconvolve and show the cleaned image
			// CLEAN params pinned here for the UI (they match clean.js's own defaults);
			// gain 0.1 / 300 iters / 3% threshold are tuned for the 128² teaching scale.
			const { cleaned, iterations } = hogbomClean(lastDirty, lastBeam, N, { gain: 0.1, maxIter: 300, thresholdFrac: 0.03 });
			renderField(canvases.dirty, cleaned, N, INFERNO, true);
			btn.setAttribute('aria-pressed', 'true');
			btn.textContent = '↺ Show dirty';
			if (hint) hint.textContent = `CLEANed · ${iterations} iters`;
		}
	});
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
			const { dirty, beam, filled } = dirtyFromVisibilities(data.cells, data.n);
			eht = { dirty, beam, n: data.n };
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
			renderField(cv.beam, cropCentre(beam, data.n, EHT_CROP), EHT_CROP, GRAY, true);
			renderField(cv.dirty, cropCentre(dirty, data.n, EHT_CROP), EHT_CROP, INFERNO, true);
			$('eht-uv-hint').textContent = `${filled} cells · ${data.nVisibilities.toLocaleString()} vis`;
			$('eht-stage').hidden = false;
			loadBtn.hidden = true;
		} catch (e) {
			console.error('EHT capstone load failed:', e);
			loadBtn.disabled = false; loadBtn.textContent = '▼ Load failed — retry';
		}
	});

	$('eht-clean').addEventListener('click', () => {
		if (!eht) return;
		const btn = $('eht-clean'), hint = $('eht-recon-hint');
		if (btn.getAttribute('aria-pressed') === 'true') {
			renderField(cv.dirty, cropCentre(eht.dirty, eht.n, EHT_CROP), EHT_CROP, INFERNO, true);
			btn.setAttribute('aria-pressed', 'false'); btn.textContent = '✦ CLEAN it up';
			hint.textContent = 'the dirty image';
		} else {
			// Conservative CLEAN on the sparse EHT data: stop at 6% of peak so it pulls out
			// the central source without digging spurious structure from the sidelobes — the
			// over-CLEANing this whole tool warns about is most dangerous exactly here.
			const { cleaned, iterations } = hogbomClean(eht.dirty, eht.beam, eht.n, { gain: 0.1, maxIter: 120, thresholdFrac: 0.06 });
			renderField(cv.dirty, cropCentre(cleaned, eht.n, EHT_CROP), EHT_CROP, INFERNO, true);
			btn.setAttribute('aria-pressed', 'true'); btn.textContent = '↺ Show dirty';
			hint.textContent = `CLEANed · ${iterations} iters`;
		}
	});
}

// Wire controls (ui.js mutates `state` and calls `update`), then do the first paint.
initUI(state, update, canvases.array);
wireCleanButton();
wireEHTCapstone();
update();
