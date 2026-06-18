// render.js — map the B field to pixels through a colour lookup table. Kept separate from the sim
// so colour is a pure presentation concern (and so palettes are easy to add later).

// makeLUT — build a 256-entry RGB lookup table from a list of [stop, r,g,b] colour stops (stop in
// 0..1), linearly interpolated. Precomputing means the per-pixel render is a single table lookup.
export function makeLUT(stops) {
	const lut = new Uint8Array(256 * 3);
	for (let i = 0; i < 256; i++) {
		const t = i / 255;
		let s = 0;
		while (s < stops.length - 2 && stops[s + 1][0] < t) s++;
		const [t0, r0, g0, b0] = stops[s], [t1, r1, g1, b1] = stops[Math.min(s + 1, stops.length - 1)];
		const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
		lut[i * 3] = r0 + (r1 - r0) * u;
		lut[i * 3 + 1] = g0 + (g1 - g0) * u;
		lut[i * 3 + 2] = b0 + (b1 - b0) * u;
	}
	return lut;
}

// A couple of palettes (each a stop list). "teal" reads like the BZ dish; "ember" is warm.
export const PALETTES = {
	teal: makeLUT([[0, 8, 12, 22], [0.4, 18, 90, 96], [0.7, 90, 210, 200], [1, 240, 255, 250]]),
	ember: makeLUT([[0, 10, 6, 14], [0.45, 120, 24, 40], [0.75, 240, 120, 30], [1, 255, 240, 180]]),
	mono: makeLUT([[0, 6, 8, 13], [1, 235, 240, 250]]),
};

// renderField — write B (scaled by `hi`, the expected max ≈ 0.4) through `lut` into the ImageData,
// then blit to the canvas context. ctx/img are reused across frames by the caller.
export function renderField(ctx, img, b, lut, hi = 0.4) {
	const data = img.data, n = b.length, scale = 255 / hi;
	for (let i = 0; i < n; i++) {
		let c = (b[i] * scale) | 0;
		if (c < 0) c = 0; else if (c > 255) c = 255;
		const o = i * 4, l = c * 3;
		data[o] = lut[l]; data[o + 1] = lut[l + 1]; data[o + 2] = lut[l + 2]; data[o + 3] = 255;
	}
	ctx.putImageData(img, 0, 0);
}
