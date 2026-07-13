// ui.js — wire the DOM controls to scene state, including dragging dishes on the
// array-map canvas. It mutates the `state` object main.js owns and calls `update`
// after every change; it never renders directly (render.js does that via update).

import { arrayPreset } from './arrays.js';
import { MAP_EXTENT_M } from './config.js';

const MAX_DISHES = 36; // cap: baseline count is O(m²), so beyond this the UI bogs down

// Shared cancel for the "Observe a night" animation. wireRotation assigns the real
// implementation; every other control calls this so a user interaction during the
// sweep stops it cleanly instead of racing repaints. No-op until assigned.
let cancelObserve = () => {};

// setActive — mark one button current within its group: the 'active' class for the
// look, aria-pressed for assistive tech (the toggle-group state, not color alone).
function setActive(buttons, chosen) {
	buttons.forEach((b) => {
		const on = b === chosen;
		b.classList.toggle('active', on);
		b.setAttribute('aria-pressed', String(on));
	});
}

// clearActive — clear current-state from every button matching a selector (used when
// the array becomes a hand-edited "custom" array, matching no preset).
function clearActive(selector) {
	document.querySelectorAll(selector).forEach((b) => {
		b.classList.remove('active');
		b.setAttribute('aria-pressed', 'false');
	});
}

// markCustom — the array no longer matches a named preset (the user dragged or
// added/removed a dish). Reflect that in the state + UI.
function markCustom(state) {
	state.arrayName = 'custom';
	clearActive('[data-array]');
	document.getElementById('array-desc').textContent =
		'Custom array — drag dishes, or add and remove them, and watch the uv-coverage and the reconstruction respond.';
}

// initUI — entry point called once from main.js after the DOM exists.
//   state  : the scene state object (mutated here).
//   update : main.js's recompute+repaint function.
//   arrayCanvas : the ground-map canvas, for drag handling.
export function initUI(state, update, arrayCanvas) {
	wireSky(state, update);
	wireArray(state, update);
	wireDeclination(state, update);
	wireRotation(state, update);
	wireNoise(state, update);
	wireDishButtons(state, update);
	wireDrag(state, update, arrayCanvas);
	document.getElementById('array-desc').textContent = arrayPreset(state.arrayName).description;
}

// wireSky — target-preset buttons (data-sky attribute).
function wireSky(state, update) {
	const btns = [...document.querySelectorAll('[data-sky]')];
	btns.forEach((b) => b.addEventListener('click', () => {
		cancelObserve();
		state.sky = b.dataset.sky;
		setActive(btns, b);
		update();
	}));
}

// wireArray — array-preset buttons (data-array attribute). Clones the preset's
// antennas so later edits don't mutate the shared preset.
function wireArray(state, update) {
	const btns = [...document.querySelectorAll('[data-array]')];
	btns.forEach((b) => b.addEventListener('click', () => {
		cancelObserve();
		const p = arrayPreset(b.dataset.array);
		state.arrayName = b.dataset.array;
		state.antennas = p.antennas.map((a) => ({ e: a.e, n: a.n }));
		state.latDeg = p.latDeg;
		state.dragIndex = -1; // the antenna set was replaced; any in-flight drag index is now stale
		setActive(btns, b);
		document.getElementById('array-desc').textContent = p.description;
		update();
	}));
}

// wireDeclination — the source-declination slider. Declination foreshortens the
// north–south uv-coverage (v ∝ cos δ at transit), so it visibly squashes coverage
// for low-declination sources even in a snapshot.
function wireDeclination(state, update) {
	const slider = document.getElementById('dec-slider');
	const label = document.getElementById('dec-value');
	// aria-valuetext gives a screen reader "45 degrees" instead of a bare "45".
	const apply = () => {
		cancelObserve();
		state.decDeg = +slider.value;
		label.textContent = `${slider.value}°`;
		slider.setAttribute('aria-valuetext', `${slider.value} degrees`);
		update();
	};
	slider.addEventListener('input', apply);
	label.textContent = `${slider.value}°`; // initial label only; main.js does the first paint
	slider.setAttribute('aria-valuetext', `${slider.value} degrees`);
}

// wireRotation — the Earth-rotation slider (hours observed) plus the "Observe a
// night" animation that sweeps the uv-tracks open in real time. This is the core
// "synthesis" interaction: a few dishes + the turning Earth → dense coverage.
function wireRotation(state, update) {
	const slider = document.getElementById('rot-slider');
	const label = document.getElementById('rot-value');
	const btn = document.getElementById('observe-btn');
	let raf = 0; // active requestAnimationFrame handle, 0 when idle

	// Translate a half-span (degrees of hour angle either side of transit) into scene
	// state. 0° = a single snapshot; larger spans sweep longer arcs. ~1 sample per 4°
	// keeps the arcs reading as continuous lines. 15°/hour converts span → hours.
	const setSpan = (halfSpan) => {
		state.haStartDeg = -halfSpan;
		state.haEndDeg = halfSpan;
		// snapshot at 0; otherwise at least 2 samples so a non-snapshot span never
		// silently collapses to a single point while the label still reads "X h".
		state.haSteps = halfSpan === 0 ? 1 : Math.max(2, Math.round((2 * halfSpan) / 4));
		const text = halfSpan === 0 ? 'snapshot' : `${((2 * halfSpan) / 15).toFixed(1)} h`;
		label.textContent = text;
		// aria-valuetext exposes the meaningful value ("4.0 hours"), not the raw 0–90.
		slider.setAttribute('aria-valuetext', halfSpan === 0 ? 'snapshot' : `${((2 * halfSpan) / 15).toFixed(1)} hours`);
	};
	const stopObserve = () => {
		if (raf) { cancelAnimationFrame(raf); raf = 0; }
		btn.classList.remove('running');
	};
	cancelObserve = stopObserve; // expose so other controls can halt the animation

	slider.addEventListener('input', () => { stopObserve(); setSpan(+slider.value); update(); });
	setSpan(+slider.value); // sync state + label to the slider's initial value

	// Observe: animate the span from 0 up to the slider value over ~1.6s, so the
	// uv-plane visibly fills and the image sharpens as the "night" progresses.
	const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	btn.addEventListener('click', () => {
		stopObserve();
		const target = (+slider.value) || 60; // parked at snapshot ⇒ sweep to ±60°
		slider.value = target;
		// Honor reduced-motion: jump straight to the filled result, skip the sweep.
		// The educational endpoint is identical; only the in-between motion is removed.
		if (reduceMotion()) { setSpan(target); update(); return; }
		btn.classList.add('running');
		const t0 = performance.now(), dur = 1600;
		const tick = (now) => {
			const k = Math.min(1, (now - t0) / dur);
			setSpan(target * k);
			update();
			if (k < 1) { raf = requestAnimationFrame(tick); }
			else { raf = 0; btn.classList.remove('running'); }
		};
		raf = requestAnimationFrame(tick);
	});
}

// wireNoise — the thermal-noise slider (0–100% of signal). Real interferometers
// measure each visibility with finite SNR; turning this up degrades the dirty image
// and, crucially, sets a floor that CLEAN should not dig below (over-cleaning into
// noise invents spurious sources).
function wireNoise(state, update) {
	const slider = document.getElementById('noise-slider');
	const label = document.getElementById('noise-value');
	const setLabel = () => {
		const text = slider.value === '0' ? 'off' : `${slider.value}%`;
		label.textContent = text;
		slider.setAttribute('aria-valuetext', text === 'off' ? 'off' : `${slider.value} percent`);
	};
	slider.addEventListener('input', () => {
		cancelObserve();
		state.noiseLevel = (+slider.value) / 100;
		setLabel();
		update();
	});
	setLabel();
}

// wireDishButtons — add a dish (on a golden-angle spiral so successive dishes never
// land on top of each other) or remove the last one. A baseline needs two dishes, so
// removal stops at two; adding stops at MAX_DISHES (baseline count is O(m²)).
function wireDishButtons(state, update) {
	const golden = Math.PI * (3 - Math.sqrt(5)); // ≈137.5°: the non-repeating spiral angle
	document.getElementById('add-dish').addEventListener('click', () => {
		cancelObserve();
		if (state.antennas.length >= MAX_DISHES) return; // hard cap, keeps the UI responsive
		const k = state.antennas.length;
		const a = k * golden;
		const r = 120 + 620 * Math.sqrt(k / MAX_DISHES); // monotonic radius, bounded inside the map window
		state.antennas.push({ e: r * Math.cos(a), n: r * Math.sin(a) });
		markCustom(state);
		update();
	});
	document.getElementById('remove-dish').addEventListener('click', () => {
		cancelObserve();
		if (state.antennas.length > 2) {            // keep at least one baseline
			state.antennas.pop();
			state.dragIndex = -1;                   // array shrank; any drag index may now be stale
			markCustom(state);
			update();
		}
	});
}

// canvasMetres — convert a pointer event to ground metres (and raw canvas pixels).
// Accounts for the gap between the canvas's CSS size and its internal resolution.
function canvasMetres(canvas, ev) {
	const rect = canvas.getBoundingClientRect();
	const px = (ev.clientX - rect.left) * (canvas.width / rect.width);
	const py = (ev.clientY - rect.top) * (canvas.height / rect.height);
	const s = (Math.min(canvas.width, canvas.height) / 2) / MAP_EXTENT_M; // metres → px
	return { e: (px - canvas.width / 2) / s, n: (canvas.height / 2 - py) / s, px, py };
}

// nearestDish — index of the dish within grab distance of canvas pixel (px,py), or -1.
function nearestDish(state, canvas, px, py) {
	const s = (Math.min(canvas.width, canvas.height) / 2) / MAP_EXTENT_M;
	let best = -1, bestD = 16 * 16; // 16px grab radius, squared
	state.antennas.forEach((a, i) => {
		const x = canvas.width / 2 + a.e * s, y = canvas.height / 2 - a.n * s;
		const d = (x - px) ** 2 + (y - py) ** 2;
		if (d < bestD) { bestD = d; best = i; }
	});
	return best;
}

// wireDrag — pointer drag to reposition a dish. Clamps to the map window so a dish
// can't be dragged off-frame.
function wireDrag(state, update, canvas) {
	// End a drag: clear the active index and repaint (drops the gold highlight).
	const end = () => { if (state.dragIndex >= 0) { state.dragIndex = -1; update(); } };

	canvas.addEventListener('pointerdown', (ev) => {
		const m = canvasMetres(canvas, ev);
		const i = nearestDish(state, canvas, m.px, m.py);
		if (i >= 0) { state.dragIndex = i; canvas.setPointerCapture(ev.pointerId); update(); }
	});
	canvas.addEventListener('pointermove', (ev) => {
		if (state.dragIndex < 0) return;
		// Bail if the button was released off-canvas (no buttons held) or the index
		// went stale (array shrank/replaced mid-drag) — either would otherwise leave a
		// dish stuck to the cursor or write past the end of the antenna array.
		if (ev.buttons === 0 || state.dragIndex >= state.antennas.length) { end(); return; }
		const m = canvasMetres(canvas, ev);
		const clamp = (x) => Math.max(-MAP_EXTENT_M, Math.min(MAP_EXTENT_M, x));
		state.antennas[state.dragIndex] = { e: clamp(m.e), n: clamp(m.n) };
		markCustom(state);
		update();
	});
	canvas.addEventListener('pointerup', end);
	canvas.addEventListener('pointercancel', end);
	canvas.addEventListener('lostpointercapture', end); // capture lost (focus change) ⇒ end cleanly

	// --- keyboard equivalent of dish dragging ------------------------------------------
	// The map canvas is focusable (tabindex=0 in the HTML). Bracket keys select a dish and
	// arrow keys nudge it in fixed increments — equivalent CONTROL for keyboard-only users,
	// the accessibility review's falsifier (not just canned array presets). Selection reuses
	// state.dragIndex, so renderArrayMap's existing gold highlight marks the SELECTED dish for
	// free; position/selection changes are spoken through #live-status (the aria-live region).
	const STEP_M = MAP_EXTENT_M / 20;                 // 50 m per press across the 1000 m half-window
	const clampM = (x) => Math.max(-MAP_EXTENT_M, Math.min(MAP_EXTENT_M, x));
	const live = document.getElementById('live-status');
	const announceDish = () => {
		if (!live || state.dragIndex < 0) return;
		const a = state.antennas[state.dragIndex];
		live.textContent = `Dish ${state.dragIndex + 1} of ${state.antennas.length} selected — `
			+ `east ${Math.round(a.e)} metres, north ${Math.round(a.n)} metres.`;
	};

	canvas.addEventListener('focus', () => {
		// Select the first dish on keyboard entry if none is active, so arrows act at once.
		// Guarded on dragIndex<0 so a pointerdown that just grabbed a dish isn't overridden
		// (pointerdown fires before the focus default action, so it wins).
		if (state.dragIndex < 0 && state.antennas.length) { state.dragIndex = 0; update(); announceDish(); }
	});
	canvas.addEventListener('blur', () => {
		if (state.dragIndex >= 0) { state.dragIndex = -1; update(); } // drop the highlight on leave
	});
	canvas.addEventListener('keydown', (ev) => {
		if (!state.antennas.length) return;
		// Recover a valid selection if the array shrank or was replaced since focus.
		if (state.dragIndex < 0 || state.dragIndex >= state.antennas.length) state.dragIndex = 0;
		const i = state.dragIndex, a = state.antennas[i];
		let handled = true;
		switch (ev.key) {
			// Move the selected dish. north = +n = screen-up, matching the array map's orientation.
			case 'ArrowLeft':  state.antennas[i] = { e: clampM(a.e - STEP_M), n: a.n }; markCustom(state); break;
			case 'ArrowRight': state.antennas[i] = { e: clampM(a.e + STEP_M), n: a.n }; markCustom(state); break;
			case 'ArrowUp':    state.antennas[i] = { e: a.e, n: clampM(a.n + STEP_M) }; markCustom(state); break;
			case 'ArrowDown':  state.antennas[i] = { e: a.e, n: clampM(a.n - STEP_M) }; markCustom(state); break;
			// Cycle the selection (wrapping). Brackets are the primary keys; comma/period are
			// easier reaches on some layouts and do the same thing.
			case '[': case ',': state.dragIndex = (i - 1 + state.antennas.length) % state.antennas.length; break;
			case ']': case '.': state.dragIndex = (i + 1) % state.antennas.length; break;
			case 'Home': state.dragIndex = 0; break;
			default: handled = false;
		}
		if (handled) { ev.preventDefault(); update(); announceDish(); } // preventDefault stops arrows scrolling
	});
}
