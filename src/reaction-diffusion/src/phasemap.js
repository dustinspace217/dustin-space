// phasemap.js — a little interactive map of the Gray-Scott (feed f, kill k) plane. It plots the
// named regimes as labelled points and a live crosshair at the current (f,k); click or drag inside
// it to set f/k and watch the live pattern morph through phase space. Deliberately NOT a pre-painted
// region map — that would fake precise boundaries; the running simulation is the honest ground truth,
// and this is just orientation ("where am I relative to the named regimes").
const F_MIN = 0.010, F_MAX = 0.080, K_MIN = 0.040, K_MAX = 0.070, PAD = 20;

// makePhaseMap — draw into `canvas`, plotting `presets` (each {f,k,name}); call `onPick(f,k)` while
// the user drags. Returns { setCur } so the host can move the crosshair when sliders/presets change.
export function makePhaseMap(canvas, presets, onPick) {
	const ctx = canvas.getContext('2d');
	const W = canvas.width, H = canvas.height;
	const fx = (f) => PAD + (f - F_MIN) / (F_MAX - F_MIN) * (W - 2 * PAD);
	const ky = (k) => PAD + (k - K_MIN) / (K_MAX - K_MIN) * (H - 2 * PAD);
	const xToF = (x) => F_MIN + (x - PAD) / (W - 2 * PAD) * (F_MAX - F_MIN);
	const yToK = (y) => K_MIN + (y - PAD) / (H - 2 * PAD) * (K_MAX - K_MIN);
	const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
	let cur = { f: presets[0].f, k: presets[0].k };

	function draw() {
		ctx.clearRect(0, 0, W, H);
		ctx.strokeStyle = '#1c2433'; ctx.lineWidth = 1; ctx.strokeRect(PAD, PAD, W - 2 * PAD, H - 2 * PAD);
		ctx.fillStyle = '#5a6678'; ctx.font = '9px ui-monospace';
		ctx.fillText('feed →', W - PAD - 38, H - 6);
		ctx.save(); ctx.translate(11, PAD + 40); ctx.rotate(-Math.PI / 2); ctx.fillText('kill →', 0, 0); ctx.restore();
		for (const p of presets) {                       // named-regime points
			const x = fx(p.f), y = ky(p.k);
			ctx.fillStyle = 'rgba(95,208,200,0.45)'; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
			ctx.fillStyle = '#7c8aa0'; ctx.font = '8px ui-monospace'; ctx.fillText(p.name, x + 5, y + 3);
		}
		const cx = fx(cur.f), cy = ky(cur.k);            // live crosshair
		ctx.strokeStyle = '#5fd0c8'; ctx.lineWidth = 2;
		ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 7); ctx.stroke();
		ctx.beginPath(); ctx.moveTo(cx - 9, cy); ctx.lineTo(cx + 9, cy); ctx.moveTo(cx, cy - 9); ctx.lineTo(cx, cy + 9); ctx.stroke();
	}

	// onPick(f, k, fresh): `fresh` is true on a fresh tap (pointerdown), false while dragging — so the
	// host can RESEED on a tap (always show what a region makes from a clean start) but MORPH on drag
	// (a smooth glide through phase space). Reseeding mid-drag would just restart every frame.
	let dragging = false;
	const pick = (ev, fresh) => {
		const r = canvas.getBoundingClientRect();
		const f = clamp(xToF((ev.clientX - r.left) / r.width * W), F_MIN, F_MAX);
		const k = clamp(yToK((ev.clientY - r.top) / r.height * H), K_MIN, K_MAX);
		cur = { f, k }; draw(); onPick(f, k, fresh);
	};
	canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); pick(e, true); });
	canvas.addEventListener('pointermove', (e) => { if (dragging) pick(e, false); });
	canvas.addEventListener('pointerup', () => { dragging = false; });
	canvas.addEventListener('pointercancel', () => { dragging = false; });

	draw();
	return { setCur(f, k) { cur = { f, k }; draw(); } };
}
