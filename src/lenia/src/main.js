// Lenia Lab — page wiring: engine, controls, specimen bench, survey map.
//
// Data flow: creatures.json (known species) and finds.json (search
// discoveries) populate the specimen bench; survey.json paints the (μ,σ)
// survey map. All three are fetched relative to the page so the same files
// work locally and under /lenia/ on the site. The live world runs on
// GlEngine (WebGL2); this file owns UI state and the animation loop.

import { GlEngine } from './gl/engine.js';
import { CpuSim } from './core/sim.js';
import { decodeCells } from './core/rle.js';
import { mulberry32 } from './core/rng.js';

const WORLD_N = 256;

// (μ, σ) ranges shared by the sliders, the survey map axes, and the search
// sweep (tools/search.js uses the same values — keep in sync, they define
// what "the explored space" means everywhere on this page).
const MU_MIN = 0.05, MU_MAX = 0.40;
const SIGMA_MIN = 0.004, SIGMA_MAX = 0.064;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state --
let engine = null;
let creatures = [];         // known species from creatures.json
let finds = [];             // discovered species from finds.json (Task 5)
let survey = null;          // survey.json grid (Task 5)
let current = null;         // currently selected specimen object
let running = true;
let stepsPerFrame = 2;
let erasing = false;        // held-E / right-button erase mode

// Reduced motion: the simulation is the page's only large motion — honor the
// preference by starting paused behind an explicit Run control.
const prefersStill = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------- boot ------
async function boot() {
	const canvas = $('cv');
	try {
		// Default species parameters get replaced by the real Orbium entry as
		// soon as creatures.json loads; these literals only matter if the
		// fetch fails, in which case the world still runs (empty).
		engine = new GlEngine(canvas, WORLD_N, { R: 13, T: 10, mu: 0.15, sigma: 0.015, beta: [1] });
	} catch (err) {
		// No WebGL2 / no float rendering: swap the canvas for the message.
		canvas.hidden = true;
		const box = $('gl-error');
		box.hidden = false;
		box.textContent = err.message + ' The explainer below still works — only the live world needs the GPU.';
		$('hint').hidden = true;
		return;
	}

	// If the GPU context dies (driver reset, tab backgrounded too long on
	// some platforms), say so instead of freezing silently.
	canvas.addEventListener('webglcontextlost', (e) => {
		e.preventDefault();
		running = false;
		const box = $('gl-error');
		box.hidden = false;
		box.textContent = 'The GPU context was lost. Reload the page to restart the world.';
	});

	try {
		const res = await fetch('data/creatures.json');
		if (!res.ok) throw new Error(`creatures.json: HTTP ${res.status}`);
		// Validate SHAPE, not just fetch success: a syntactically valid JSON
		// with the wrong structure (missing/renamed `creatures`) would leave the
		// whole bench dead with no message. Throw to the same catch so the shape
		// failure surfaces exactly like a fetch failure.
		const doc = await res.json();
		if (!Array.isArray(doc.creatures)) throw new Error('bad format');
		creatures = doc.creatures;
	} catch (err) {
		// The bench is the page's content — a load failure must be visible,
		// not a silently empty control group.
		$('species').textContent = 'Species data failed to load (' + err.message + ').';
	}
	try {
		const res = await fetch('data/finds.json');
		// Coerce to [] on a wrong shape rather than letting `finds` become
		// undefined (which .filter/.length downstream would throw on).
		if (res.ok) {
			const doc = await res.json();
			finds = Array.isArray(doc.finds) ? doc.finds : [];
		}
	} catch { /* finds are optional until the search has run — note shown below */ }
	try {
		const res = await fetch('data/survey.json');
		// Only accept a survey whose grids are present and array-shaped —
		// drawSurveyCells and buildBench read survey.cells / survey.muGrid, and
		// a half-formed object would half-draw the map or throw mid-render.
		if (res.ok) {
			const doc = await res.json();
			if (Array.isArray(doc.cells) && Array.isArray(doc.muGrid)) survey = doc;
		}
	} catch { /* survey optional likewise */ }

	// Wrap the wiring so a throw in any setup step surfaces a message instead of
	// freezing boot with a live-but-inert page (buttons unwired, map blank).
	try {
		buildBench();
		wireControls();
		wireBrush(canvas);
		drawSurvey();
	} catch (err) {
		const box = $('gl-error');
		box.hidden = false;
		box.textContent = 'The page failed to finish loading (' + err.message + ').';
	}

	if (creatures.length) selectSpecimen(creatures[0], document.querySelector('#species button'));

	if (prefersStill) {
		running = false;
		$('play').textContent = '▶ Run';
	}
	requestAnimationFrame(frame);
}

// ------------------------------------------------------------ bench ------
function buildBench() {
	const box = $('species');
	box.textContent = '';
	for (const c of creatures) {
		const b = document.createElement('button');
		b.textContent = c.nick;
		b.setAttribute('aria-pressed', 'false');
		b.addEventListener('click', () => selectSpecimen(c, b));
		box.appendChild(b);
	}
	// Bench shows only FEATURED finds (the visually distinct representatives
	// — see tools/curate.js NAMED); every find still gets a survey-map pin.
	for (const f of finds.filter(f => f.featured)) {
		const b = document.createElement('button');
		b.textContent = f.nick;
		b.classList.add('find');
		b.setAttribute('aria-pressed', 'false');
		// The ⌖ mark is CSS-only (::before), invisible to a screen reader — name
		// the discovery status in the accessible label so finds read distinctly
		// from Chan's known species.
		b.setAttribute('aria-label', f.nick + ' (search discovery)');
		b.addEventListener('click', () => selectSpecimen(f, b));
		box.appendChild(b);
	}
	if (!survey) {
		$('survey-note').textContent = 'Survey data not loaded — the map shows known species only.';
	} else {
		const total = survey.cells.reduce((s, c) => s + c.dead + c.exploded + c.static + c.mover + c.other, 0);
		$('survey-note').textContent = `${total} simulated worlds. Violet: alive as texture. `
			+ `Warm: exploded. Dark: died. Pins: known species (hollow) and search finds (filled).`;
	}
}

function selectSpecimen(spec, btn) {
	current = spec;
	for (const b of document.querySelectorAll('#species button')) b.setAttribute('aria-pressed', 'false');
	if (btn) btn.setAttribute('aria-pressed', 'true');

	engine.setSpecies(spec);
	$('mu').value = spec.mu;
	$('sigma').value = spec.sigma;
	updateReadouts();

	// Card: italic Latin name, the specimen's vitals, one-line field note.
	$('sp-name').textContent = spec.name;
	// Finds carry a measured speed; known species don't need one on the card.
	$('sp-meta').textContent = `R ${spec.R} · T ${spec.T} · μ ${spec.mu} · σ ${spec.sigma}`
		+ (spec.speed ? ` · ${spec.speed} cells/unit` : '');
	$('sp-blurb').textContent = spec.blurb ?? '';

	respawn();
	drawSurvey();
}

// Clear the world and stamp the current specimen in the middle.
function respawn() {
	if (!engine || !current) return;
	engine.clear();
	// Guard the decode: a specimen with missing or malformed cells (hand-edited
	// data, a bad find) must not throw out of the click handler and leave
	// selection half-done. On failure show a brief note in the hint area and
	// leave the world cleared — the rest of the bench stays usable.
	let cells;
	try {
		if (!current.cells) throw new Error('no cell data');
		cells = decodeCells(current.cells);
	} catch (err) {
		$('hint').textContent = `Could not load “${current.nick ?? current.name ?? 'specimen'}” (${err.message}).`;
		engine.draw();
		return;
	}
	engine.placeCells(cells,
		Math.floor(WORLD_N / 2 - cells.w / 2),
		Math.floor(WORLD_N / 2 - cells.h / 2));
	engine.draw();
}

// ---------------------------------------------------------- controls -----
function updateReadouts() {
	$('mu-val').textContent = Number($('mu').value).toFixed(4);
	$('sigma-val').textContent = Number($('sigma').value).toFixed(4);
}

function wireControls() {
	$('mu').addEventListener('input', () => {
		engine.setParams({ mu: Number($('mu').value) });
		updateReadouts(); drawSurvey();
	});
	$('sigma').addEventListener('input', () => {
		engine.setParams({ sigma: Number($('sigma').value) });
		updateReadouts(); drawSurvey();
	});

	$('play').addEventListener('click', () => {
		running = !running;
		// The label swap (⏸ Pause / ▶ Run) IS the state a screen reader reads —
		// an aria-pressed toggle on top of a changing label double-announces and
		// is the accessibility-audit finding here, so the button carries no
		// aria-pressed at all.
		$('play').textContent = running ? '⏸ Pause' : '▶ Run';
	});
	$('respawn').addEventListener('click', respawn);
	$('clear').addEventListener('click', () => { engine.clear(); engine.draw(); });

	for (const b of document.querySelectorAll('#speed button')) {
		b.addEventListener('click', () => {
			stepsPerFrame = Number(b.dataset.speed);
			for (const o of document.querySelectorAll('#speed button')) o.setAttribute('aria-pressed', 'false');
			b.setAttribute('aria-pressed', 'true');
		});
	}
	for (const b of document.querySelectorAll('#palette button')) {
		b.addEventListener('click', () => {
			engine.palette = Number(b.dataset.palette);
			for (const o of document.querySelectorAll('#palette button')) o.setAttribute('aria-pressed', 'false');
			b.setAttribute('aria-pressed', 'true');
			if (!running) engine.draw();
		});
	}

	window.addEventListener('keydown', (e) => { if (e.key === 'e' || e.key === 'E') erasing = true; });
	window.addEventListener('keyup', (e) => { if (e.key === 'e' || e.key === 'E') erasing = false; });

	// The WebGL world resizes its drawing buffer inside draw(); the survey is a
	// 2D canvas that only redraws on interaction, so it goes stale/blurry after
	// a window resize or DPR change until the next drag. Redraw it on resize.
	// No debounce — drawSurvey is a handful of canvas ops, cheap to re-run.
	window.addEventListener('resize', drawSurvey);

	wireSurveyPointer();
}

// ------------------------------------------------------------- brush -----
function wireBrush(canvas) {
	let painting = false;
	let eraseStroke = false;

	// Pointer position -> world cell coords. The display shader puts texture
	// row 0 at the BOTTOM of the canvas (GL convention), so screen-y inverts.
	const toWorld = (e) => {
		const r = canvas.getBoundingClientRect();
		return {
			x: (e.clientX - r.left) / r.width * WORLD_N,
			y: (1 - (e.clientY - r.top) / r.height) * WORLD_N,
		};
	};
	const dab = (e) => {
		const { x, y } = toWorld(e);
		const erase = eraseStroke || erasing;
		engine.splat(x, y, erase ? 10 : 5, erase ? -1.2 : 0.85);
		if (!running) engine.draw();
	};

	canvas.addEventListener('contextmenu', (e) => e.preventDefault());
	canvas.addEventListener('pointerdown', (e) => {
		painting = true;
		eraseStroke = e.button === 2;
		canvas.setPointerCapture(e.pointerId);
		dab(e);
	});
	canvas.addEventListener('pointermove', (e) => { if (painting) dab(e); });
	canvas.addEventListener('pointerup', () => { painting = false; eraseStroke = false; });
	canvas.addEventListener('pointercancel', () => { painting = false; eraseStroke = false; });
}

// -------------------------------------------------------- survey map -----
// Axes: μ linear left->right, σ GEOMETRIC bottom->top (the search samples σ
// geometrically — equal ratios matter more than equal differences for a
// width parameter). Survey cells (Task 5) paint under the pins; until then
// the map is a live position indicator over dark water.
function surveyXY(mu, sigma, w, h) {
	const x = (mu - MU_MIN) / (MU_MAX - MU_MIN) * w;
	const y = h - (Math.log(sigma / SIGMA_MIN) / Math.log(SIGMA_MAX / SIGMA_MIN)) * h;
	return { x, y };
}

function drawSurvey() {
	const cv = $('survey');
	const dpr = window.devicePixelRatio || 1;
	const w = Math.round(cv.clientWidth * dpr) || 292 * dpr;
	const h = Math.round(cv.clientHeight * dpr) || 180 * dpr;
	if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
	const ctx = cv.getContext('2d');
	ctx.clearRect(0, 0, w, h);

	// Survey outcome cells (present once data/survey.json ships — Task 5).
	if (survey) drawSurveyCells(ctx, w, h);

	// Known-species pins: hollow circles, labeled by nickname on hover is
	// overkill at this size — the bench IS the legend (same order).
	ctx.strokeStyle = 'rgba(207, 220, 218, 0.7)';
	ctx.lineWidth = dpr;
	for (const c of creatures) {
		const { x, y } = surveyXY(c.mu, c.sigma, w, h);
		ctx.beginPath(); ctx.arc(x, y, 3 * dpr, 0, Math.PI * 2); ctx.stroke();
	}
	// Discovery pins: filled accent.
	ctx.fillStyle = '#6fe3a3';
	for (const f of finds) {
		const { x, y } = surveyXY(f.mu, f.sigma, w, h);
		ctx.beginPath(); ctx.arc(x, y, 2.5 * dpr, 0, Math.PI * 2); ctx.fill();
	}
	// Live crosshair at the current sliders.
	const mu = Number($('mu').value), sigma = Number($('sigma').value);
	const { x, y } = surveyXY(mu, sigma, w, h);
	ctx.strokeStyle = '#6fe3a3';
	ctx.beginPath();
	ctx.moveTo(x - 6 * dpr, y); ctx.lineTo(x + 6 * dpr, y);
	ctx.moveTo(x, y - 6 * dpr); ctx.lineTo(x, y + 6 * dpr);
	ctx.stroke();
}

// Survey cells, painted once data/survey.json ships. Cell colors encode
// outcome, not decoration: mover -> accent glow, static -> dim cyan,
// exploded-dominant -> warm, dead-dominant -> near-black.
//
// Each grid value is a cell CENTER; the painted rectangle spans the
// midpoints to its neighbors (boundary cells extend symmetrically). Painting
// center-to-next-center instead would shift every cell by half a step and
// misattribute outcomes at regime boundaries — exactly where the map is
// most interesting.
function cellEdges(grid, k, isLog) {
	const c = grid[k];
	const lo = k > 0 ? grid[k - 1] : null;
	const hi = k < grid.length - 1 ? grid[k + 1] : null;
	if (isLog) {
		// Geometric grid: midpoints are geometric means; boundaries mirror
		// the neighbor ratio.
		const rLo = lo ? Math.sqrt(c / lo) : (hi ? Math.sqrt(hi / c) : 1.1);
		const rHi = hi ? Math.sqrt(hi / c) : (lo ? Math.sqrt(c / lo) : 1.1);
		return [c / rLo, c * rHi];
	}
	const dLo = lo !== null ? (c - lo) / 2 : (hi !== null ? (hi - c) / 2 : 0.005);
	const dHi = hi !== null ? (hi - c) / 2 : (lo !== null ? (c - lo) / 2 : 0.005);
	return [c - dLo, c + dHi];
}

function drawSurveyCells(ctx, w, h) {
	const { muGrid, sigmaGrid, cells } = survey;
	for (const cell of cells) {
		const total = cell.dead + cell.exploded + cell.static + cell.mover + cell.other;
		if (!total) continue;
		const [mu0, mu1] = cellEdges(muGrid, cell.i, false);
		const [sg0, sg1] = cellEdges(sigmaGrid, cell.j, true);
		const a = surveyXY(mu0, sg0, w, h);   // bottom-left in data space
		const b = surveyXY(mu1, sg1, w, h);   // top-right in data space
		// Color priority mirrors how interesting each outcome is, not how
		// common: any mover lights the cell accent-green; statics cyan;
		// then the DOMINANT bulk outcome — 'other' (alive-but-texture,
		// the Turing-pattern belt) dim violet, explosion warm, death
		// near-black. Without the violet tier the entire living region
		// of the map would render as indistinguishable darkness.
		const alive = cell.other, boom = cell.exploded;
		let fill;
		if (cell.mover > 0) fill = `rgba(111, 227, 163, ${0.25 + 0.6 * cell.mover / total})`;
		else if (cell.static > 0) fill = `rgba(95, 160, 180, ${0.15 + 0.4 * cell.static / total})`;
		else if (alive >= boom && alive > cell.dead) fill = `rgba(139, 122, 216, ${0.14 + 0.30 * alive / total})`;
		else if (boom > cell.dead) fill = `rgba(224, 112, 95, ${0.10 + 0.25 * boom / total})`;
		else fill = 'rgba(18, 28, 32, 0.6)';
		ctx.fillStyle = fill;
		ctx.fillRect(a.x, b.y, b.x - a.x, a.y - b.y);
	}
}

function wireSurveyPointer() {
	const cv = $('survey');
	let dragging = false;
	const apply = (e) => {
		const r = cv.getBoundingClientRect();
		const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
		const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
		const mu = MU_MIN + fx * (MU_MAX - MU_MIN);
		const sigma = SIGMA_MIN * Math.pow(SIGMA_MAX / SIGMA_MIN, 1 - fy);
		$('mu').value = mu; $('sigma').value = sigma;
		engine.setParams({ mu, sigma });
		updateReadouts(); drawSurvey();
	};
	cv.addEventListener('pointerdown', (e) => { dragging = true; cv.setPointerCapture(e.pointerId); apply(e); });
	cv.addEventListener('pointermove', (e) => { if (dragging) apply(e); });
	cv.addEventListener('pointerup', () => { dragging = false; });
	cv.addEventListener('pointercancel', () => { dragging = false; });
}

// -------------------------------------------------------------- loop -----
function frame() {
	if (engine) {
		// A GPU call throwing mid-loop must not silently freeze the world with
		// no explanation. Surface it via #gl-error (role=alert) and keep
		// rescheduling: a persistent fault keeps the message up, while a
		// transient one clears on the next good frame. Rescheduling beats
		// stopping — a stopped loop looks identical to a paused one.
		try {
			if (running) engine.step(stepsPerFrame);
			engine.draw();
		} catch (err) {
			const box = $('gl-error');
			box.hidden = false;
			box.textContent = 'The live world hit an error (' + err.message + '). Try reloading the page.';
		}
	}
	requestAnimationFrame(frame);
}

boot();

// Exposed for the QA parity probe (Playwright reaches in via window) — not
// part of the page's own behavior.
window.__leniaDebug = {
	get engine() { return engine; },
	mulberry32,
	decodeCells,
	CpuSim,        // lets the parity probe run the CPU engine against the GPU one
};
