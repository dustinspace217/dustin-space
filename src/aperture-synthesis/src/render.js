// render.js — all canvas drawing for the four panels. Pure presentation: it reads
// arrays/points and paints them, holding no simulation state.
//
// Two kinds of panel:
//   - FIELDS (true sky, dirty beam, dirty image): N×N scalar arrays drawn as images
//     via an offscreen N×N canvas blitted up to panel size.
//   - VECTOR overlays (array map, uv-plane): dots and axes drawn directly.

// makeColormap — build a t∈[0,1] → [r,g,b] function by linearly interpolating a
// short list of anchor colours. Small and dependency-free; good enough to look like
// the real thing without shipping a 256-entry table.
function makeColormap(anchors) {
	return function (t) {
		const x = Math.min(1, Math.max(0, t)) * (anchors.length - 1);
		const i = Math.floor(x), f = x - i;
		const a = anchors[i], b = anchors[Math.min(anchors.length - 1, i + 1)];
		return [
			Math.round(a[0] + (b[0] - a[0]) * f),
			Math.round(a[1] + (b[1] - a[1]) * f),
			Math.round(a[2] + (b[2] - a[2]) * f),
		];
	};
}

// Inferno-ish: the dark-purple→orange→pale-yellow ramp astronomers use for
// brightness. Grayscale for the beam, where negative sidelobes matter and a
// perceptual ramp would distract.
export const INFERNO = makeColormap([
	[0, 0, 4], [87, 16, 110], [188, 55, 84], [249, 142, 9], [252, 255, 164],
]);
export const GRAY = makeColormap([[0, 0, 0], [255, 255, 255]]);

// renderField — draw an N×N scalar array as a colour-mapped image, normalized to
// its own min..max so faint structure stays visible.
//   canvas : destination <canvas>.  arr : Float64Array(n*n).  n : side.
//   cmap : colormap function.  smooth : bilinear upscale (true) vs blocky (false).
export function renderField(canvas, arr, n, cmap, smooth) {
	// Scan for the value range, ignoring any non-finite entry (the real pipeline never
	// produces one, but this is an exported utility — guard the trust boundary).
	let mn = Infinity, mx = -Infinity;
	for (let i = 0; i < arr.length; i++) {
		const v = arr[i];
		if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
	}
	let span = mx - mn;
	if (!(span > 0) || !Number.isFinite(span)) span = 1; // flat field or no finite values

	const off = document.createElement('canvas');
	off.width = n; off.height = n;
	const octx = off.getContext('2d');
	const id = octx.createImageData(n, n);
	for (let i = 0; i < arr.length; i++) {
		const t = (arr[i] - mn) / span;
		const [r, g, b] = cmap(Number.isFinite(t) ? t : 0); // never index the colormap with NaN
		const o = i * 4;
		id.data[o] = r; id.data[o + 1] = g; id.data[o + 2] = b; id.data[o + 3] = 255;
	}
	octx.putImageData(id, 0, 0);

	const ctx = canvas.getContext('2d');
	ctx.imageSmoothingEnabled = smooth;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
}

// renderArrayMap — draw the dishes on the ground (East→right, North→up) within a
// fixed metre window so positions stay stable while dragging.
//   antennas : [{e,n}] metres.  extentM : half-window in metres (edge = ±extentM).
//   dragIndex : index of the dish being dragged (highlighted), or -1.
export function renderArrayMap(canvas, antennas, extentM, dragIndex) {
	const ctx = canvas.getContext('2d');
	const w = canvas.width, h = canvas.height, cx = w / 2, cy = h / 2;
	const s = (Math.min(w, h) / 2) / extentM; // metres → pixels
	ctx.clearRect(0, 0, w, h);
	ctx.fillStyle = '#0a0e16'; ctx.fillRect(0, 0, w, h);
	// reference axes through the array centre
	ctx.strokeStyle = '#1d2735'; ctx.lineWidth = 1;
	ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();
	for (let i = 0; i < antennas.length; i++) {
		const x = cx + antennas[i].e * s, y = cy - antennas[i].n * s; // North up ⇒ minus
		ctx.beginPath(); ctx.arc(x, y, i === dragIndex ? 8 : 6, 0, 2 * Math.PI);
		ctx.fillStyle = i === dragIndex ? '#ffd166' : '#5ec8ff';
		ctx.fill();
		ctx.strokeStyle = '#0a0e16'; ctx.lineWidth = 2; ctx.stroke();
	}
}

// renderUv — draw the sampled spatial frequencies. Measured samples in cyan and
// their Hermitian conjugates (−u,−v) in a dimmer tone, to make the point-symmetry
// (which comes from the sky being real) visible rather than asserted.
//   points : [{u,v}] wavelengths.  uvMax : wavelengths mapped to the panel edge.
export function renderUv(canvas, points, uvMax) {
	const ctx = canvas.getContext('2d');
	const w = canvas.width, h = canvas.height, cx = w / 2, cy = h / 2;
	const s = (Math.min(w, h) / 2) / uvMax; // wavelengths → pixels
	ctx.clearRect(0, 0, w, h);
	ctx.fillStyle = '#0a0e16'; ctx.fillRect(0, 0, w, h);
	ctx.strokeStyle = '#1d2735'; ctx.lineWidth = 1;
	ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();
	// outline the grid edge: samples beyond this circle fall outside the imaged field
	ctx.beginPath(); ctx.arc(cx, cy, (Math.min(w, h) / 2), 0, 2 * Math.PI); ctx.stroke();
	for (let p = 0; p < points.length; p++) {
		const u = points[p].u * s, v = points[p].v * s;
		ctx.fillStyle = 'rgba(94,200,255,0.9)';
		ctx.beginPath(); ctx.arc(cx + u, cy - v, 2.2, 0, 2 * Math.PI); ctx.fill(); // measured
		ctx.fillStyle = 'rgba(94,200,255,0.35)';
		ctx.beginPath(); ctx.arc(cx - u, cy + v, 2.2, 0, 2 * Math.PI); ctx.fill(); // conjugate
	}
}
