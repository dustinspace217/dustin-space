// main.js — the interactive reaction-diffusion explorable. Two engines, one canvas:
//   • PATTERNS (Gray-Scott) — stationary spots/stripes/mazes (Turing morphogenesis).
//   • WAVES (Barkley excitable medium) — travelling spiral & target waves (the BZ reaction).
// A mode toggle swaps which engine runs and which controls show. Both are real reaction-diffusion
// PDEs, hand-solved in vanilla JS — the two faces of the same "two things diffusing" idea.
import { makeFields, seedSquare, step, swap, stamp, clear } from './sim.js';
import { makeBarkley, seedSpiral, seedTargets, stepBarkley, stampBarkley, clearBarkley, A as BK_A, B as BK_B, EPS as BK_EPS } from './barkley.js';
import { renderField, PALETTES } from './render.js';
import { makePhaseMap } from './phasemap.js';

const W = 256, H = 256;
const $ = (id) => document.getElementById(id);

// Gray-Scott regimes (feed f, kill k) — the well-known values from the literature.
const PRESETS = [
	{ id: 'mitosis', f: 0.0367, k: 0.0649, name: 'Mitosis', blurb: 'blobs that split and replicate like dividing cells' },
	{ id: 'coral', f: 0.0545, k: 0.0620, name: 'Coral', blurb: 'branching, growing coral fronts' },
	{ id: 'maze', f: 0.0290, k: 0.0570, name: 'Maze', blurb: 'winding labyrinth corridors' },
	{ id: 'solitons', f: 0.0300, k: 0.0620, name: 'Solitons', blurb: 'stable persistent dots that never merge' },
	{ id: 'worms', f: 0.0540, k: 0.0630, name: 'Worms', blurb: 'wriggling worm-like stripes' },
	{ id: 'waves', f: 0.0140, k: 0.0540, name: 'Waves', blurb: 'expanding wavefronts' },
];
const BZ_SEEDS = {
	spiral: { id: 'spiral', name: 'Spiral', blurb: 'a single rotating spiral wave', seed: seedSpiral },
	targets: { id: 'targets', name: 'Targets', blurb: 'expanding concentric rings from pacemaker sites', seed: seedTargets },
};

const state = { mode: 'gray', f: PRESETS[0].f, k: PRESETS[0].k, running: true, palette: PALETTES.teal, bzSeed: 'spiral' };
let phasemap = null;
const gray = makeFields(W, H); seedSquare(gray, 24);
const bz = makeBarkley(W, H); seedSpiral(bz);   // initial seed only keeps bz valid; setMode('bz') reseeds on entry

const cv = $('cv'), ctx = cv.getContext('2d', { alpha: false });
const img = ctx.createImageData(W, H);

// --- Gray-Scott controls -----------------------------------------------------------------
function setFK(f, k, label) {
	state.f = f; state.k = k;
	$('f-slider').value = String(f); $('k-slider').value = String(k);
	$('fk-readout').textContent = `feed ${f.toFixed(4)} · kill ${k.toFixed(4)}`;
	if (label) $('regime').textContent = label;
}
function applyPreset(p) {
	setFK(p.f, p.k, `${p.name} — ${p.blurb}`);
	clear(gray); seedSquare(gray, 24);
	phasemap?.setCur(p.f, p.k);
	document.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === p.id)));
}
const onSlider = () => {
	setFK(+$('f-slider').value, +$('k-slider').value);
	phasemap?.setCur(state.f, state.k);
	$('regime').textContent = 'custom — explore the phase diagram';
	document.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
};

// --- BZ (waves) controls -----------------------------------------------------------------
function applyBzSeed(id) {
	state.bzSeed = id;
	const s = BZ_SEEDS[id]; s.seed(bz);
	$('regime').textContent = `${s.name} — ${s.blurb}`;
	document.querySelectorAll('[data-bz]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.bz === id)));
}

// --- mode toggle -------------------------------------------------------------------------
function setMode(m) {
	state.mode = m;
	$('gray-controls').hidden = m !== 'gray';
	$('bz-controls').hidden = m !== 'bz';
	document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
	if (m === 'gray') applyPreset(PRESETS.find((p) => p.id === 'mitosis'));
	else applyBzSeed(state.bzSeed);
}

// --- paint-to-seed (dispatches by mode) --------------------------------------------------
let painting = false;
// Seed at GRID coords (gx, gy), dispatching by mode. Extracted so the pointer
// path (paintAt) and the keyboard path (wireKeyboardSeed) seed IDENTICALLY:
// Gray-Scott gets a slightly larger brush; BZ a smaller spark (a big excited
// blob just floods the excitable medium rather than launching a clean wave).
function seedAt(gx, gy) {
	if (state.mode === 'gray') stamp(gray, gx, gy, 6); else stampBarkley(bz, gx, gy, 5);
}
function paintAt(ev) {
	const r = cv.getBoundingClientRect();
	const gx = Math.floor((ev.clientX - r.left) / r.width * W);
	const gy = Math.floor((ev.clientY - r.top) / r.height * H);
	seedAt(gx, gy);
}
cv.addEventListener('pointerdown', (e) => { painting = true; cv.setPointerCapture(e.pointerId); paintAt(e); });
cv.addEventListener('pointermove', (e) => { if (painting) paintAt(e); });
cv.addEventListener('pointerup', () => { painting = false; });
cv.addEventListener('pointercancel', () => { painting = false; });

// --- keyboard-to-seed (equivalent control for keyboard-only users) -----------------------
// The canvas is focusable (tabindex=0 in the HTML). Arrow keys drive a visible
// cursor (#seed-cursor); Enter or Space seeds at it via the same seedAt the
// pointer path uses. This is the accessibility review's falsifier: keyboard
// users get equivalent CONTROL over WHERE the seed lands, not just presets.
(function wireKeyboardSeed() {
	const dot = document.getElementById('seed-cursor');
	if (!dot) return;                     // markup absent -> pointer path still works
	// Cursor in grid cells; starts at centre. The 2D canvas is un-inverted
	// (row 0 at top), so screen-y maps straight through (unlike Lenia's GL world).
	let gx = W >> 1, gy = H >> 1;
	const place = () => {
		dot.style.left = (cv.offsetLeft + (gx + 0.5) / W * cv.clientWidth) + 'px';
		dot.style.top = (cv.offsetTop + (gy + 0.5) / H * cv.clientHeight) + 'px';
	};
	const show = () => { dot.hidden = false; place(); };
	const STEP = 8;                       // 8 cells per press across the 256-cell field
	cv.addEventListener('keydown', (e) => {
		let handled = true;
		switch (e.key) {
			case 'ArrowLeft':  gx = Math.max(0, gx - STEP); break;
			case 'ArrowRight': gx = Math.min(W - 1, gx + STEP); break;
			case 'ArrowUp':    gy = Math.max(0, gy - STEP); break;
			case 'ArrowDown':  gy = Math.min(H - 1, gy + STEP); break;
			case 'Enter': case ' ': seedAt(gx, gy); break;
			default: handled = false;
		}
		if (handled) { e.preventDefault(); show(); }   // preventDefault stops arrows/Space scrolling the page
	});
	cv.addEventListener('focus', show);
	cv.addEventListener('blur', () => { dot.hidden = true; });
	window.addEventListener('resize', () => { if (!dot.hidden) place(); });
})();

// --- wire controls -----------------------------------------------------------------------
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => applyPreset(PRESETS.find((p) => p.id === b.dataset.preset))));
document.querySelectorAll('[data-bz]').forEach((b) => b.addEventListener('click', () => applyBzSeed(b.dataset.bz)));
$('f-slider').addEventListener('input', onSlider);
$('k-slider').addEventListener('input', onSlider);
$('play').addEventListener('click', () => { state.running = !state.running; $('play').textContent = state.running ? '⏸ Pause' : '▶ Play'; });
$('reset').addEventListener('click', () => {
	if (state.mode === 'gray') { clear(gray); seedSquare(gray, 24); } else BZ_SEEDS[state.bzSeed].seed(bz);
});
$('clear').addEventListener('click', () => { if (state.mode === 'gray') clear(gray); else clearBarkley(bz); });
document.querySelectorAll('[data-palette]').forEach((b) =>
	b.addEventListener('click', () => {
		state.palette = PALETTES[b.dataset.palette];
		document.querySelectorAll('[data-palette]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
	}));

// --- phase map (Gray-Scott only) ---------------------------------------------------------
phasemap = makePhaseMap($('phasemap'), PRESETS, (f, k, fresh) => {
	setFK(f, k);
	if (fresh) { clear(gray); seedSquare(gray, 24); }   // tap = fresh start; drag = morph the current pattern
	$('regime').textContent = 'custom — drag through phase space';
	document.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
});

// --- the loop: run the active engine several steps per frame, then paint -----------------
function loop() {
	if (state.mode === 'gray') {
		if (state.running) for (let s = 0; s < 8; s++) { step(gray, state.f, state.k); swap(gray); }
		renderField(ctx, img, gray.b, state.palette, 0.4);
	} else {
		if (state.running) for (let s = 0; s < 6; s++) stepBarkley(bz, BK_A, BK_B, BK_EPS, 0.025, 12);
		renderField(ctx, img, bz.u, state.palette, 1.0);
	}
	requestAnimationFrame(loop);
}
applyPreset(PRESETS[0]);
requestAnimationFrame(loop);
