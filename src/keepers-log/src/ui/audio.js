// audio.js — the station's air: synthesized ambience, no assets.
//
// Art-direction §Sound: WebAudio synthesis only, started on a user gesture,
// defaulting quiet. Four voices and a rule:
//   WIND  — band-passed noise, scaled by weather, slowly gusting.
//   SURF  — low-passed noise under a long swell LFO; the sea never stops.
//   CLOCK — the lens drive's soft double-tick; sound and light share a
//           clock, so it runs only while the lamp is lit. When the lamp
//           goes out for good (the epilogue), the clock stops and the
//           weather keeps blowing — silence is a state too.
//   HORN  — the diaphone, fog only, distant, on a long slow cycle.
//
// Everything is one graph built once; state changes only move gain/filter
// AudioParams (setTargetAtTime — no zipper noise, no rebuilds). Randomness
// (gust drift, horn spacing) is fine here: ambience is presentation, not
// game state, and determinism guarantees live in the engine, not the air.

// Weather → target gains for wind and surf. The numbers are the mix — tuned
// by ear against the drawing, not physics; storm doubles the sea and lets
// the wind lead.
const WIND_LEVELS = { clear: 0.045, fog: 0.06, blow: 0.16, storm: 0.3 };
const SURF_LEVELS = { clear: 0.07, fog: 0.08, blow: 0.12, storm: 0.2 };

// The master sits low on purpose: the game is a reading experience with
// weather outside the window, never a soundtrack.
const MASTER_LEVEL = 0.22;

/**
 * noiseSource — a looping white-noise buffer source.
 * Receives the AudioContext and a length in seconds; returns a started
 *   AudioBufferSourceNode. Two seconds of noise looped is indistinguishable
 *   from endless noise once filtered — the buffer stays tiny.
 */
function noiseSource(ctx, seconds = 2) {
	const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
	const data = buffer.getChannelData(0);
	for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
	const src = ctx.createBufferSource();
	src.buffer = buffer;
	src.loop = true;
	src.start();
	return src;
}

/**
 * mountAudio — build the (dormant) ambience controller.
 * Returns { enable, setWeather, setLamp, toggleMuted, isMuted }.
 * Nothing touches the AudioContext until enable() runs from a user gesture
 *   (autoplay policy: a context created cold starts suspended; we create it
 *   inside enable() so the whole module is inert until the player asks for
 *   air). All later setters are safe to call before enable — they record
 *   intent and the graph is built to match on enable.
 */
export function mountAudio() {
	let ctx = null;
	let master = null;
	let windGain = null, windFilter = null;
	let surfGain = null;
	let clockGain = null, clockTimer = null;
	let hornTimer = null;
	let muted = false;

	// Intent recorded before/while the graph exists; applied on every change.
	let weather = 'clear';
	let lampLit = true;

	/** applyWeather — move wind/surf gains toward the current weather's mix. */
	function applyWeather() {
		if (!ctx) return;
		const t = ctx.currentTime;
		windGain.gain.setTargetAtTime(WIND_LEVELS[weather] ?? 0.05, t, 1.5);
		surfGain.gain.setTargetAtTime(SURF_LEVELS[weather] ?? 0.07, t, 1.5);
		// The horn sounds in fog only; (re)arm or disarm its cycle.
		if (weather === 'fog' && hornTimer == null) armHorn();
		if (weather !== 'fog' && hornTimer != null) { clearTimeout(hornTimer); hornTimer = null; }
	}

	/**
	 * tick — one soft double-tick of the lens drive: gear, then pawl.
	 * Voiced as PITCHED metal, not noise (retuned 2026-07-24 after Dustin's
	 *   live listen: the noise-click version read as a rhythmic record
	 *   scratch, not machinery — a click made of noise says "vinyl"). Each
	 *   tick is two brief inharmonic sine partials with a fast exponential
	 *   decay — the spectral shape of a struck escapement wheel — with the
	 *   pawl's answer slightly lower and quieter, the way a real train
	 *   settles. Quiet enough to live under the wind; present enough that
	 *   its STOPPING is felt (the epilogue's silence).
	 */
	function tick() {
		if (!ctx || !lampLit) return;
		// [offset s, partial frequencies Hz, peak gain] — gear then pawl.
		const strikes = [
			[0, [2100, 3170], 0.05],
			[0.18, [1660, 2510], 0.035],
		];
		for (const [offset, partials, peak] of strikes) {
			const t = ctx.currentTime + offset;
			const g = ctx.createGain();
			g.gain.setValueAtTime(0.0001, t);
			g.gain.exponentialRampToValueAtTime(peak, t + 0.002);
			g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
			g.connect(clockGain);
			for (const freq of partials) {
				const osc = ctx.createOscillator();
				osc.type = 'sine';
				osc.frequency.value = freq;
				osc.connect(g);
				osc.start(t);
				osc.stop(t + 0.1);
			}
		}
	}

	/**
	 * horn — one distant diaphone blast: a low tone and its deeper partner,
	 * slow attack, long release, heavily low-passed — a shape heard through
	 * weather rather than a note played at the listener.
	 */
	function horn() {
		if (!ctx) return;
		const t = ctx.currentTime;
		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass'; lp.frequency.value = 420;
		const g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.exponentialRampToValueAtTime(0.11, t + 0.9);
		g.gain.setValueAtTime(0.11, t + 2.2);
		g.gain.exponentialRampToValueAtTime(0.0001, t + 3.4);
		lp.connect(g).connect(master);
		for (const freq of [136, 91]) {
			const osc = ctx.createOscillator();
			osc.type = 'triangle';
			osc.frequency.value = freq;
			osc.connect(lp);
			osc.start(t);
			osc.stop(t + 3.6);
		}
	}

	/** armHorn — schedule the next blast on a long, slightly loose cycle. */
	function armHorn() {
		hornTimer = setTimeout(() => {
			if (weather === 'fog') { horn(); armHorn(); }
			else hornTimer = null;
		}, 42000 + Math.random() * 12000);
	}

	/**
	 * enable — build and start the graph. MUST be called from a user gesture
	 * (the cover's begin/resume click). Idempotent.
	 */
	function enable() {
		if (ctx) return;
		ctx = new (window.AudioContext || window.webkitAudioContext)();
		// AT-5 (QA-2026-07-24): some engines return a context in the 'suspended'
		// state even when it is created inside a user gesture — the graph would
		// build but stay silent until something resumed it. Resume explicitly; it
		// is a no-op when already running, and a rejected promise (rare — e.g. no
		// output device) is not fatal to the reading experience, so it is ignored.
		ctx.resume?.().catch(() => {});
		master = ctx.createGain();
		master.gain.value = muted ? 0 : MASTER_LEVEL;
		master.connect(ctx.destination);

		// WIND: noise → bandpass (gusting center freq via LFO) → gain.
		windFilter = ctx.createBiquadFilter();
		windFilter.type = 'bandpass';
		windFilter.frequency.value = 420;
		windFilter.Q.value = 0.6;
		windGain = ctx.createGain();
		windGain.gain.value = 0;
		noiseSource(ctx).connect(windFilter).connect(windGain).connect(master);
		const gust = ctx.createOscillator();
		gust.frequency.value = 0.07; // one slow gust cycle ~14s
		const gustDepth = ctx.createGain();
		gustDepth.gain.value = 160; // Hz swing on the wind's center
		gust.connect(gustDepth).connect(windFilter.frequency);
		gust.start();

		// SURF: noise → lowpass → gain, breathing under a long swell LFO.
		const surfFilter = ctx.createBiquadFilter();
		surfFilter.type = 'lowpass';
		surfFilter.frequency.value = 240;
		surfGain = ctx.createGain();
		surfGain.gain.value = 0;
		noiseSource(ctx).connect(surfFilter).connect(surfGain).connect(master);
		const swell = ctx.createOscillator();
		swell.frequency.value = 0.09;
		const swellDepth = ctx.createGain();
		swellDepth.gain.value = 0.035; // gentle rise and fall on the surf gain
		swell.connect(swellDepth).connect(surfGain.gain);
		swell.start();

		// CLOCK: its own bus so the lamp can silence it without touching air.
		clockGain = ctx.createGain();
		clockGain.gain.value = 1;
		clockGain.connect(master);
		clockTimer = setInterval(tick, 4000); // the drive's unhurried rhythm

		applyWeather();
	}

	return {
		enable,
		/** setWeather — the game hands us the day's weather word. */
		setWeather(w) { weather = w; applyWeather(); },
		/** setLamp — lit runs the clockwork; dark lets it run down. At the finale
		 * the scene calls setLamp(false); tick() then returns early, so the clock
		 * goes silent (art-direction: "scored by wind alone") and the idle interval
		 * is torn down by the reload moments later. The former epilogue() method
		 * that cleared the interval eagerly was dead code (no caller) and is gone
		 * (QA-2026-07-24 CR-5) — setLamp(false) already silences it. */
		setLamp(lit) { lampLit = lit; },
		/** toggleMuted — the one listener control; returns the new muted state. */
		toggleMuted() {
			muted = !muted;
			if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL, ctx.currentTime, 0.1);
			return muted;
		},
		isMuted() { return muted; },
	};
}
