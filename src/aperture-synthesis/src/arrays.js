// arrays.js — antenna array geometries (the dishes on the ground).
//
// Each preset returns ground positions in metres (East, North) plus the array's
// latitude (needed to project baselines onto the sky — see physics.js). All presets
// share the LAMBDA / UV_MAX scale in config.js, so their uv-coverage is directly
// comparable: more dishes and longer baselines visibly reach farther and sharpen
// the image.
//
// NOTE on the EHT: true VLBI (the EHT) spans continents — antennas at different
// latitudes and longitudes — which this single-latitude ground model does not
// represent. Rather than fake it with a sparse compact array, the genuine EHT
// case is reserved for the Phase 5 real-data capstone, which loads the actual
// released (u,v) tracks directly and bypasses this ground model entirely.

export const ARRAY_NAMES = ['two', 'triangle', 'spiral', 'vlaY'];

const LAT_VLA = 34; // degrees N — roughly the VLA site latitude, used for all presets

// circleAntennas — m evenly spaced dishes on a circle of given radius (metres).
// Used for the small triangle, where 3 dishes can't form grating lobes anyway.
function circleAntennas(m, radius) {
	const out = [];
	for (let k = 0; k < m; k++) {
		const a = (2 * Math.PI * k) / m;
		out.push({ e: radius * Math.cos(a), n: radius * Math.sin(a) });
	}
	return out;
}

// spiralAntennas — m dishes on a phyllotaxis ("sunflower") spiral out to rMax metres.
// WHY a spiral and not an evenly-spaced ring for the default good array: a regular
// ring is near-redundant — many antenna pairs share the same baseline — so it acts
// like a diffraction grating and aliases the source into periodic copies (grating
// lobes). The golden-angle spiral makes every baseline distinct, so the uv-plane
// fills smoothly and the dirty beam has a single clean peak. Real arrays (VLA,
// ALMA) are deliberately irregular for exactly this reason. Bounded by m.
function spiralAntennas(m, rMax) {
	const golden = Math.PI * (3 - Math.sqrt(5)); // ≈2.39996 rad, the golden angle
	const out = [];
	for (let k = 0; k < m; k++) {
		const r = rMax * Math.sqrt((k + 0.5) / m); // equal-area spacing fills the disk
		const a = k * golden;
		out.push({ e: r * Math.cos(a), n: r * Math.sin(a) });
	}
	return out;
}

// yAntennas — a VLA-style Y: three arms at 120°, each with dishes at the given
// radii (metres). Produces the characteristic three-fold uv pattern.
function yAntennas(radii) {
	const out = [];
	for (let arm = 0; arm < 3; arm++) {
		const a = (2 * Math.PI * arm) / 3 + Math.PI / 2; // 90°, 210°, 330°
		for (let r = 0; r < radii.length; r++) {
			out.push({ e: radii[r] * Math.cos(a), n: radii[r] * Math.sin(a) });
		}
	}
	return out;
}

// arrayPreset — look up a named array. Returns { label, description, latDeg,
// antennas }. Throws on an unknown name (explicit failure over a silent empty array).
export function arrayPreset(name) {
	switch (name) {
		case 'two':
			return {
				label: '2 dishes',
				description: 'A single east–west baseline. One pair = one spatial frequency (plus its mirror). A snapshot gives just fringes — the minimal interferometer.',
				latDeg: LAT_VLA,
				antennas: [{ e: -350, n: 0 }, { e: 350, n: 0 }],
			};
		case 'triangle':
			return {
				label: '3 dishes',
				description: 'A triangle gives three baselines at three orientations — six uv points. Still sparse, but you can start to see structure rather than stripes.',
				latDeg: LAT_VLA,
				antennas: circleAntennas(3, 500),
			};
		case 'spiral':
			return {
				label: '12 irregular',
				description: 'Twelve dishes in a golden-angle spiral — no two baselines alike, so the uv-plane fills smoothly and the beam stays clean. Real arrays are deliberately irregular for exactly this reason: an evenly-spaced ring would act like a diffraction grating and replicate the source.',
				latDeg: LAT_VLA,
				antennas: spiralAntennas(12, 760),
			};
		case 'vlaY':
			return {
				label: 'VLA-style Y',
				description: 'Three arms at 120°, dishes packed toward the centre. The hallmark of the Very Large Array; its three-fold uv pattern shapes the beam.',
				latDeg: LAT_VLA,
				antennas: yAntennas([150, 350, 550, 750]),
			};
		default:
			throw new Error(`arrayPreset: unknown array '${name}'`);
	}
}
