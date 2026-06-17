// physics.js — interferometer geometry and uv-sampling.
//
// This module turns an array of dishes on the ground into the set of (u,v) points
// it samples in the spatial-frequency plane. That sampling pattern is the heart of
// aperture synthesis: each PAIR of dishes (a "baseline") measures one spatial
// frequency of the sky, and Earth's rotation drags each baseline through many more.
//
// Coordinate chain (all standard radio-astronomy conventions, see Thompson, Moran
// & Swenson, "Interferometry and Synthesis in Radio Astronomy"):
//   ground (East/North, metres) → equatorial (X,Y,Z) at array latitude φ
//                               → (u,v,w) at hour angle H and declination δ
// We work in the small-field approximation and ignore w (stated in the UI), which
// is the standard simplification for a narrow field of view.

const DEG = Math.PI / 180;

// enuToXyz — convert a ground baseline (East, North; Up assumed 0 on flat ground)
// into the Earth-fixed equatorial frame (X toward H=0&δ=0, Y toward H=−6h, Z toward
// the north celestial pole). `latDeg` is the array's geodetic latitude.
//   d : {e, n} baseline components in metres (antenna B minus antenna A).
//   latDeg : array latitude in degrees.
// Returns {x, y, z} in metres. Up component dropped (flat-ground assumption).
export function enuToXyz(d, latDeg) {
	const phi = latDeg * DEG;
	return {
		x: -d.n * Math.sin(phi), // toward the celestial equator on the meridian
		y: d.e,                  // due east
		z: d.n * Math.cos(phi),  // toward the north celestial pole
	};
}

// baselineToUv — project one equatorial baseline (X,Y,Z, metres) onto the (u,v)
// plane for a source at hour angle H and declination δ, then convert to wavelengths.
//   xyz   : {x, y, z} from enuToXyz.
//   hRad  : hour angle in radians (0 = source on the meridian; advances with time).
//   decRad: source declination in radians.
//   lambda: observing wavelength in metres (u,v come out in wavelengths).
// Returns {u, v}. We omit w because the small-field imaging below doesn't use it.
export function baselineToUv(xyz, hRad, decRad, lambda) {
	const sinH = Math.sin(hRad), cosH = Math.cos(hRad);
	const sinD = Math.sin(decRad), cosD = Math.cos(decRad);
	const u = sinH * xyz.x + cosH * xyz.y;
	const v = -sinD * cosH * xyz.x + sinD * sinH * xyz.y + cosD * xyz.z;
	return { u: u / lambda, v: v / lambda };
}

// sampleUv — full uv-coverage for an array over a range of hour angles.
//   antennas: array of {e, n} ground positions in metres.
//   opts: { latDeg, decDeg, lambda, haStartDeg, haEndDeg, haSteps }
//     - latDeg/decDeg : array latitude and source declination, degrees.
//     - lambda        : observing wavelength, metres.
//     - haStart/End   : hour-angle span to "rotate" through, degrees (15°/hour).
//     - haSteps       : how many time samples across that span (>=1).
// Returns a flat array of {u, v} points. We add ONLY the direct samples here; the
// Hermitian conjugates (−u,−v) are added at the gridding step in imaging.js, so a
// caller plotting these sees the physically measured half and the mirror is made
// explicit where it matters. Loop is bounded by baselines × haSteps (both small).
export function sampleUv(antennas, opts) {
	const { latDeg, decDeg, lambda, haStartDeg, haEndDeg, haSteps } = opts;
	if (!(haSteps >= 1)) throw new Error(`sampleUv: haSteps must be >=1, got ${haSteps}`);
	if (!(lambda > 0)) throw new Error(`sampleUv: lambda must be >0, got ${lambda}`);
	const decRad = decDeg * DEG;
	const points = [];

	// Precompute the equatorial baseline vector for every antenna pair once; only
	// the hour angle changes as the Earth rotates, so the geometry is reused.
	const baselines = [];
	for (let i = 0; i < antennas.length; i++) {
		for (let j = i + 1; j < antennas.length; j++) {
			const d = { e: antennas[j].e - antennas[i].e, n: antennas[j].n - antennas[i].n };
			baselines.push(enuToXyz(d, latDeg));
		}
	}

	// Sweep hour angle across the requested span. haSteps==1 collapses to a single
	// snapshot at haStartDeg (Phase 1 uses this; Phase 2 animates the full sweep).
	const denom = haSteps > 1 ? haSteps - 1 : 1;
	for (let s = 0; s < haSteps; s++) {
		const haDeg = haStartDeg + (haEndDeg - haStartDeg) * (s / denom);
		const hRad = haDeg * DEG;
		for (let b = 0; b < baselines.length; b++) {
			points.push(baselineToUv(baselines[b], hRad, decRad, lambda));
		}
	}
	return points;
}
