// main.js — the interactive reaction-diffusion explorable. Steps the Gray-Scott sim every frame,
// renders B through a palette, and wires the controls: named-regime presets, live feed/kill sliders,
// paint-to-seed, play/pause, reset, clear, palette. (Teaching copy + the BZ wave mode come later.)
import { makeFields, seedSquare, step, swap, stamp, clear } from './sim.js';
import { renderField, PALETTES } from './render.js';
import { makePhaseMap } from './phasemap.js';

const W = 256, H = 256;
const $ = (id) => document.getElementById(id);

// Named Gray-Scott regimes (feed f, kill k). Each lands in a different region of the phase diagram
// and produces a distinct pattern — the values are the well-known ones from the Gray-Scott literature.
const PRESETS = [
	{ id: 'mitosis', f: 0.0367, k: 0.0649, name: 'Mitosis', blurb: 'blobs that split and replicate like dividing cells' },
	{ id: 'coral', f: 0.0545, k: 0.0620, name: 'Coral', blurb: 'branching, growing coral fronts' },
	{ id: 'maze', f: 0.0290, k: 0.0570, name: 'Maze', blurb: 'winding labyrinth corridors' },
	{ id: 'solitons', f: 0.0300, k: 0.0620, name: 'Solitons', blurb: 'stable persistent dots that bounce, never merging' },
	{ id: 'worms', f: 0.0540, k: 0.0630, name: 'Worms', blurb: 'wriggling worm-like stripes' },
	{ id: 'waves', f: 0.0140, k: 0.0540, name: 'Waves', blurb: 'expanding wavefronts — a glimpse of the BZ regime' },
];

const state = { f: PRESETS[0].f, k: PRESETS[0].k, running: true, steps: 8, palette: PALETTES.teal };
let phasemap = null;   // assigned after the controls are wired (see below); guarded with ?.
const fields = makeFields(W, H);
seedSquare(fields, 24);

const cv = $('cv'), ctx = cv.getContext('2d', { alpha: false });
const img = ctx.createImageData(W, H);

// setFK — set feed/kill, sync the sliders + numeric readout. `label` describes the regime.
function setFK(f, k, label) {
	state.f = f; state.k = k;
	$('f-slider').value = String(f); $('k-slider').value = String(k);
	$('fk-readout').textContent = `feed ${f.toFixed(4)} · kill ${k.toFixed(4)}`;
	if (label) $('regime').textContent = label;
}

// applyPreset — jump to a regime: set f/k, wipe the dish, drop a fresh seed so the pattern grows
// from scratch, and mark the active button.
function applyPreset(p) {
	setFK(p.f, p.k, `${p.name} — ${p.blurb}`);
	clear(fields); seedSquare(fields, 24);
	phasemap?.setCur(p.f, p.k);
	document.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === p.id)));
}

// paint-to-seed — stamp B under the pointer; map canvas client coords → grid cells (the canvas is
// displayed larger than its 256² backing store, so scale by the rendered size).
let painting = false;
function paintAt(ev) {
	const r = cv.getBoundingClientRect();
	const gx = Math.floor((ev.clientX - r.left) / r.width * W);
	const gy = Math.floor((ev.clientY - r.top) / r.height * H);
	stamp(fields, gx, gy, 6);
}
cv.addEventListener('pointerdown', (e) => { painting = true; cv.setPointerCapture(e.pointerId); paintAt(e); });
cv.addEventListener('pointermove', (e) => { if (painting) paintAt(e); });
cv.addEventListener('pointerup', () => { painting = false; });
cv.addEventListener('pointercancel', () => { painting = false; });

// --- wire controls ---
document.querySelectorAll('[data-preset]').forEach((b) =>
	b.addEventListener('click', () => applyPreset(PRESETS.find((p) => p.id === b.dataset.preset))));

const onSlider = () => { setFK(+$('f-slider').value, +$('k-slider').value); phasemap?.setCur(state.f, state.k); $('regime').textContent = 'custom — explore the phase diagram'; document.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', 'false')); };
$('f-slider').addEventListener('input', onSlider);
$('k-slider').addEventListener('input', onSlider);

$('play').addEventListener('click', () => { state.running = !state.running; $('play').textContent = state.running ? '⏸ Pause' : '▶ Play'; });
$('reset').addEventListener('click', () => { clear(fields); seedSquare(fields, 24); });
$('clear').addEventListener('click', () => clear(fields));
document.querySelectorAll('[data-palette]').forEach((b) =>
	b.addEventListener('click', () => {
		state.palette = PALETTES[b.dataset.palette];
		document.querySelectorAll('[data-palette]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
	}));

// Phase map: dragging it sets f/k LIVE without reseeding, so the current pattern morphs through
// phase space (the most illuminating way to feel how f/k shape the result).
phasemap = makePhaseMap($('phasemap'), PRESETS, (f, k, fresh) => {
	setFK(f, k);
	if (fresh) { clear(fields); seedSquare(fields, 24); }   // tap = fresh start; drag = morph live
	$('regime').textContent = 'custom — drag through phase space';
	document.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
});

// --- the loop: advance several steps per frame (RD evolves slowly), then paint the field ---
function loop() {
	if (state.running) for (let s = 0; s < state.steps; s++) { step(fields, state.f, state.k); swap(fields); }
	renderField(ctx, img, fields.b, state.palette);
	requestAnimationFrame(loop);
}
applyPreset(PRESETS[0]);
requestAnimationFrame(loop);
