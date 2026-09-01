// CODA PLAYBACK — synthesized click trains at the recorded inter-click intervals.
//
// WHY this module exists: the page's entire subject is rhythm patterns in click
// bursts, and until now it never let the reader hear one. "Coda type" stays an
// abstract label until you hear that 1+1+3 is click .. click .. click-click-click
// while 5R1 is five even ticks. The corpus already ships every coda's real
// inter-click intervals (the `ici` field the ladder never reads), so hearing an
// example costs zero new data.
//
// HONESTY BOUNDARY, load-bearing: these are SYNTHESIZED ticks placed at the
// recorded intervals of one real coda. They are not recordings, and nothing in
// the UI is allowed to imply they are — sperm whale clicks are broadband pulses
// recorded underwater; a browser oscillator tick shares only the TIMING, which is
// the one dimension this page's argument is about.
//
// WHY Web Audio rather than shipping audio files: the plan's toolchain section
// commits to the browser audio API, it keeps the page's fetches-nothing-external
// property (the whole instrument stays three local files plus one data file), and
// scheduling ticks from the ici arrays means the sound is derived from the same
// shipped data the reader can inspect — the audio equivalent of "no value typed
// in by hand".

/**
 * Turn a coda's inter-click intervals into absolute click times.
 * Receives: `ici`, an array of gaps in seconds between consecutive clicks
 *           (a 5-click coda has 4 gaps).
 * Returns: an array of click onset times in seconds, starting at 0.
 *
 * Pure and exported separately from the player so the mapping is unit-testable
 * without any audio machinery: the schedule IS the argument-bearing part (the
 * rhythm), the synthesis is just how it reaches an ear.
 */
export function codaTickTimes(ici) {
	const times = [0];
	let t = 0;
	for (const gap of ici) {
		t += gap;
		times.push(t);
	}
	return times;
}

// One AudioContext for the page's lifetime, created lazily INSIDE a user gesture:
// browsers refuse (or start suspended) an AudioContext created before the user
// has interacted, so constructing it at module load would produce a player that
// silently does nothing on first press. Module scope because contexts are a
// limited OS resource — one per press would leak them.
let sharedCtx = null;

/**
 * Play one coda as a train of short ticks.
 * Receives: `ici` (the coda's inter-click gaps, seconds) and an optional
 *           `ctxFactory` (test seam: returns an AudioContext-like object;
 *           defaults to the real shared AudioContext).
 * Returns: the total duration of the train in seconds, so a caller can disable
 *          its button for exactly that long instead of guessing.
 *
 * Each tick is a short burst — a high damped oscillator with a ~20ms exponential
 * decay, stopped at 30ms. Chosen over a noise buffer because it allocates no
 * per-press sample buffer (the per-tick oscillator/gain nodes are one-shot and
 * collectable once stopped, and the strip's disable window bounds how many
 * trains can be in flight — Power-of-Ten rule 3 holds through those two bounds,
 * not through zero allocation). It also reads unambiguously as "click" at every
 * volume. The gain envelope starts at each tick's scheduled time from
 * codaTickTimes, so the audible rhythm is exactly the recorded one.
 */
export function playCoda(ici, ctxFactory) {
	let ctx;
	if (ctxFactory) {
		// Verification seam: the caller owns this context and its whole lifecycle.
		// It is deliberately NOT stored in sharedCtx and NOT auto-resumed — an
		// OfflineAudioContext (the seam's main user) throws on resume() before
		// rendering starts, and a probe's context becoming the page's shared one
		// would leave every later real button press playing into a spent buffer.
		// Both failure modes were hit live before this split existed.
		ctx = ctxFactory();
	} else {
		if (!sharedCtx) {
			sharedCtx = new AudioContext();
		}
		ctx = sharedCtx;
		// A suspended context (autoplay policy, or the tab was backgrounded)
		// resumes on the same gesture that triggered this call. The rejection is
		// swallowed DELIBERATELY, not just void-marked: this page routes every
		// unhandled rejection to its failure banner, so a wedged audio backend
		// rejecting resume() would replace the working measurement with an error
		// over a nicety (QA 2026-09-01 CR-6, async leg). Scheduling proceeds on
		// the context clock either way, and if the context truly cannot run, the
		// ticks are simply inaudible — absence, which is this feature's designed
		// failure mode.
		if (ctx.state === 'suspended') {
			ctx.resume().catch(() => {});
		}
	}
	const times = codaTickTimes(ici);
	const start = ctx.currentTime + 0.05; // small offset so tick 0 is never late
	for (const t of times) {
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		// 2.2kHz: high enough to read as a dry tick on laptop speakers, low enough
		// not to be piercing in headphones.
		osc.frequency.value = 2200;
		gain.gain.setValueAtTime(0.6, start + t);
		gain.gain.exponentialRampToValueAtTime(0.001, start + t + 0.02);
		osc.connect(gain);
		gain.connect(ctx.destination);
		osc.start(start + t);
		osc.stop(start + t + 0.03);
	}
	return times[times.length - 1] + 0.1;
}
