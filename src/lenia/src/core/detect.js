// Outcome detectors for the discovery search: given a run's recorded
// history (mass + centroid per time unit) and its final world, decide what
// happened — did the pattern die, explode, freeze, or MOVE?
//
// Everything here is a pure function over recorded data so the detectors can
// be unit-tested on synthetic histories (test/detect.test.js) without running
// a simulation — the detectors must be proven honest BEFORE they judge
// thousands of real runs, because a biased detector would silently shape
// what the survey map claims about parameter space.

// Orbium's measured speed in THIS engine (cells per time unit) — calibrated
// by the integration test in test/sim.test.js, which asserts the measurement
// stays in [4, 9]. Used only for documentation/ranking; the mover gate below
// is absolute.
export const ORBIUM_SPEED = 6.13;

// A survivor counts as a "mover" above this sustained speed (cells/unit —
// ~8% of Orbium). Why absolute rather than Orbium-relative: centroid jitter
// on breathing-but-stationary blobs measures well under 0.1 cells/unit, so
// 0.5 sits an order of magnitude above the noise floor while still catching
// slow arc-swimmers like Gyrorbium (~1-2 cells/unit).
export const MOVER_SPEED = 0.5;

// Mass thresholds relative to the run's start (m0) and world capacity (n^2).
// Both are EARLY-EXIT conditions in the runner as well as final labels —
// they bound every run's loop (Power-of-Ten rule 2).
export function isDead(mass, m0) { return mass < Math.max(1.0, 0.02 * m0); }
export function isExploded(mass, n) { return mass > 0.25 * n * n; }

// Shortest signed displacement from a to b on a ring of circumference n.
// (E.g. 126 -> 2 on n=128 is +4, not -124.) Valid when the true hop is
// under n/2 per sample — per-unit hops are a few cells, so unambiguous.
export function torusDelta(a, b, n) {
	let d = b - a;
	if (d > n / 2) d -= n;
	if (d < -n / 2) d += n;
	return d;
}

// Sustained speed from a per-unit centroid track: median of the last
// `window` per-unit hop lengths. Median, not mean: a single glitchy sample
// (e.g. a mass blip during a near-death wobble) shouldn't manufacture a
// mover. Returns 0 for tracks too short to judge.
export function sustainedSpeed(track, n, window = 20) {
	if (track.length < 2) return 0;
	const hops = [];
	const from = Math.max(1, track.length - window);
	for (let i = from; i < track.length; i++) {
		const dx = torusDelta(track[i - 1].x, track[i].x, n);
		const dy = torusDelta(track[i - 1].y, track[i].y, n);
		hops.push(Math.hypot(dx, dy));
	}
	hops.sort((a, b) => a - b);
	const mid = hops.length >> 1;
	return hops.length % 2 ? hops[mid] : (hops[mid - 1] + hops[mid]) / 2;
}

// Fraction of total mass lying within torus-distance `radius` of the
// centroid. A localized creature scores ~1.0; space-filling Turing texture
// (the "other" outcome) spreads mass everywhere and scores low.
export function localizedFraction(world, n, centroid, radius) {
	let inside = 0, total = 0;
	const r2 = radius * radius;
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const w = world[y * n + x];
			if (w === 0) continue;
			total += w;
			const dx = torusDelta(centroid.x, x, n);
			const dy = torusDelta(centroid.y, y, n);
			if (dx * dx + dy * dy <= r2) inside += w;
		}
	}
	return total > 0 ? inside / total : 0;
}

// Rotation-invariant shape signature: normalized radial mass profile —
// how the creature's mass distributes by distance from its centroid.
// Why rotation-invariant: Lenia is isotropic, so a species emerging from
// random noise swims at an arbitrary angle; direct pixel correlation would
// call two rotated copies of the SAME species different. Used by the
// curator to flag probable rediscoveries of known species.
export function radialProfile(world, n, centroid, maxRadius, bins = 16) {
	const prof = new Float64Array(bins);
	let total = 0;
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const w = world[y * n + x];
			if (w === 0) continue;
			const dx = torusDelta(centroid.x, x, n);
			const dy = torusDelta(centroid.y, y, n);
			const r = Math.hypot(dx, dy);
			if (r >= maxRadius) continue;
			prof[Math.min(bins - 1, Math.floor(r / maxRadius * bins))] += w;
			total += w;
		}
	}
	if (total > 0) for (let i = 0; i < bins; i++) prof[i] /= total;
	return prof;
}

// L2 distance between two radial profiles — small (< ~0.1) means "probably
// the same body plan".
export function profileDistance(a, b) {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
	return Math.sqrt(s);
}

// Final classification of a completed (or early-exited) run.
// Receives: history — { track: [{x,y} per unit], massFinal, m0, endedBy }
//             where endedBy is 'dead' | 'exploded' | null (ran to the cap),
//           world/n — final state (only read when the run survived),
//           R — kernel radius (localization radius scales with body size).
// Returns: { outcome, speed } with outcome one of
//           'dead' | 'exploded' | 'static' | 'mover' | 'other'.
export function classifyRun(history, world, n, R) {
	if (history.endedBy === 'dead') return { outcome: 'dead', speed: 0 };
	if (history.endedBy === 'exploded') return { outcome: 'exploded', speed: 0 };
	const track = history.track;
	const last = track[track.length - 1];
	if (!last) return { outcome: 'dead', speed: 0 };
	const speed = sustainedSpeed(track, n);
	// localizedFraction sums mass within torus-radius 3*R of the centroid. Once
	// 3*R reaches n/2 that disc wraps around and covers the entire torus, so the
	// fraction reads ~1.0 for ANY surviving pattern and the mover/static/other
	// split silently collapses. Assert the radius stays under the torus
	// half-width so a future larger-R species can't quietly bias the survey
	// (Power-of-Ten rule 5 — check the assumption the computation depends on).
	if (3 * R >= n / 2) throw new Error(`classifyRun: localization radius 3*R=${3 * R} >= n/2=${n / 2} (world too small for R=${R})`);
	const loc = localizedFraction(world, n, last, 3 * R);
	if (loc < 0.98) return { outcome: 'other', speed };
	return { outcome: speed >= MOVER_SPEED ? 'mover' : 'static', speed };
}
