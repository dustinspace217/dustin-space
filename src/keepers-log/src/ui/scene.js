// scene.js — the living cutaway: Sorrel Point drawn in ink, alive.
//
// View layer. The drawing is authored SVG markup (hand-placed paths — the
// art is code so it can be iterated like code; docs/art-direction.md is the
// visual contract). This module mounts the drawing and exposes the small
// state surface the game layer drives:
//
//   setWeather('clear'|'fog'|'blow'|'storm')  -> [data-weather] on the svg
//   setLamp(true|false)                       -> beam + window glow + the
//                                                page-wide accent drain
//                                                (html[data-lamp])
//   setFlue('blocked'|'half'|'clear')         -> smoke behavior
//   setKeeper(roomId)                         -> figure transitions between
//                                                room anchors (short slide,
//                                                not continuous walking —
//                                                consensus F6)
//
// Everything ambient (beam sweep, sea drift, smoke waver, rain fall) is CSS
// animation inside the SVG — no rAF loop, no JS timers; reduced-motion
// collapses to static states via the media query in the embedded <style>.

// Room anchor points (x,y = where the keeper figure's feet stand), matched
// to the spatial model's room ids (engine/spatial.js / station.md).
export const ANCHORS = {
	gallery: [243, 128],
	lamp: [190, 128],
	watch: [190, 208],
	base: [190, 393],
	cellar: [190, 456],
	cottage: [296, 398],
	quarters: [296, 398],
	store: [347, 398],
	workshop: [400, 398],
	siren: [605, 408],
	boathouse: [720, 423],
};

/**
 * mountScene — inject the drawing into the #cutaway svg and return its
 * control surface. Receives the svg element. The markup below is the
 * authored art; coordinates are the drawing, comments mark its regions the
 * way a plate in a manual would letter them.
 */
export function mountScene(svg) {
	// Bespoke mobile composition (Gemini round 2: uniform scaling makes the
	// plate a squint-inducing thumbnail). On narrow rooms the viewBox anchors
	// on the tower, the beam, and the keeper; the boathouse and sea bleed off
	// the right edge — a CROP, not a shrink. Live-updates on resize/rotate.
	const narrow = window.matchMedia('(max-width: 900px)');
	const applyViewBox = () => {
		svg.setAttribute('viewBox', narrow.matches ? '80 -170 560 640' : '30 -380 900 1300');
	};
	applyViewBox();
	narrow.addEventListener('change', applyViewBox);

	svg.innerHTML = `
	<style>
		/* Ink discipline: THREE weights now (Gemini round 1 — a wireframe has
		   one lineweight; a drawing has hierarchy). Heavy = the cut outer
		   masonry; ink = structure; fine = furniture, hatching, texture. */
		.ink-heavy { stroke: var(--ink); stroke-width: 2.6; fill: none; stroke-linecap: round; }
		.ink { stroke: var(--ink); stroke-width: 1.7; fill: none; stroke-linecap: round; }
		.ink-fine { stroke: var(--ink); stroke-width: 0.9; fill: none; stroke-linecap: round; }
		.wash { fill: var(--ink); opacity: 0.06; stroke: none; }

		/* THE BEAM — the page's one continuous motion and its only warm light.
		   An 8s period: a slow traverse with a bright pass, like the lens
		   coming around. Hidden entirely when the lamp is out. */
		#beam { transform-origin: 190px 100px; opacity: 0; }
		svg[data-lamp="lit"] #beam { animation: sweep 8s linear infinite; }
		@keyframes sweep {
			0%   { transform: rotate(-14deg); opacity: 0; }
			12%  { opacity: 0.55; }
			30%  { transform: rotate(10deg); opacity: 0.25; }
			50%  { transform: rotate(22deg); opacity: 0; }
			100% { transform: rotate(-14deg); opacity: 0; }
		}
		svg[data-lamp="lit"] #lampglow { opacity: 0.5; }
		#lampglow { opacity: 0; transition: opacity 1.2s; }

		/* The sea drifts; in a blow it hurries; in a storm it stands up. */
		#sea-lines { animation: drift 14s linear infinite; }
		svg[data-weather="blow"] #sea-lines { animation-duration: 7s; }
		svg[data-weather="storm"] #sea-lines { animation-duration: 4s; }
		@keyframes drift {
			from { transform: translateX(0); }
			to { transform: translateX(-28px); }
		}

		/* Weather dress: fog lays a paper-colored breath over everything;
		   rain hatches the air; storm darkens the whole plate. */
		#fog { opacity: 0; transition: opacity 2s; }
		svg[data-weather="fog"] #fog { opacity: 0.55; }
		#rain { opacity: 0; }
		svg[data-weather="storm"] #rain { opacity: 0.5; animation: rainfall 0.7s linear infinite; }
		@keyframes rainfall {
			from { transform: translateY(-14px); }
			to { transform: translateY(0); }
		}
		svg[data-weather="storm"] #stormwash { opacity: 0.14; }
		#stormwash { opacity: 0; transition: opacity 2s; }

		/* Smoke tells the flue's truth: blocked = heavy, slow, falling back;
		   half = thin and hesitant; clear = an easy rising thread. */
		#smoke path { stroke: var(--ink); fill: none; opacity: 0.35; }
		svg[data-flue="blocked"] #smoke { animation: waver 5s ease-in-out infinite; opacity: 0.8; }
		svg[data-flue="half"] #smoke { animation: waver 4s ease-in-out infinite; opacity: 0.5; }
		svg[data-flue="clear"] #smoke { animation: waver 3s ease-in-out infinite; opacity: 0.35; }
		@keyframes waver {
			0%, 100% { transform: translateX(0); }
			50% { transform: translateX(3px); }
		}

		/* The keeper: a quiet slide between rooms, never a walk cycle. */
		#keeper { transition: transform 0.9s ease-in-out; }

		@media (prefers-reduced-motion: reduce) {
			#beam, #sea-lines, #rain, #smoke, #keeper { animation: none !important; transition: none !important; }
			svg[data-lamp="lit"] #beam { opacity: 0.3; transform: rotate(4deg); }
		}
	</style>

	<defs>
		<!-- Two hatch angles at unequal spacing: the moment two imperfectly
		     aligned passes overlap, the tiling stops reading as a tile
		     (round-1 fix for the mechanical-pattern tell). -->
		<pattern id="rockhatch" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(38)">
			<line x1="0" y1="0" x2="0" y2="9" stroke="var(--ink)" stroke-width="0.8" opacity="0.3"/>
		</pattern>
		<pattern id="rockhatch2" width="23" height="23" patternUnits="userSpaceOnUse" patternTransform="rotate(29)">
			<line x1="0" y1="0" x2="0" y2="13" stroke="var(--ink)" stroke-width="0.7" opacity="0.22"/>
		</pattern>
		<!-- The rock's mass thins as it leaves the story: hatch fades to bare
		     paper instead of hitting a drawn base line. A plate ends where the
		     draughtsman stopped, not where the paper does. -->
		<linearGradient id="rockfadegrad" x1="0" y1="430" x2="0" y2="920" gradientUnits="userSpaceOnUse">
			<stop offset="0" stop-color="white"/>
			<stop offset="0.45" stop-color="white"/>
			<stop offset="1" stop-color="black"/>
		</linearGradient>
		<mask id="rockfade">
			<rect x="0" y="380" width="960" height="560" fill="url(#rockfadegrad)"/>
		</mask>
		<linearGradient id="beamfade" x1="0" y1="0" x2="1" y2="0">
			<stop offset="0" stop-color="var(--lamp)" stop-opacity="0.55"/>
			<stop offset="1" stop-color="var(--lamp)" stop-opacity="0"/>
		</linearGradient>
	</defs>

	<!-- ═══ THE SEA (right, beyond the Point) ═══ -->
	<g id="sea">
		<line class="ink-fine" x1="700" y1="430" x2="960" y2="430" opacity="0.7"/>
		<g id="sea-lines">
			<path class="ink-fine" d="M700 447 h34 m14 0 h26 m12 0 h40 m16 0 h30 m12 0 h44 m14 0 h30" opacity="0.5"/>
			<path class="ink-fine" d="M712 462 h26 m18 0 h38 m10 0 h30 m16 0 h46 m12 0 h28 m18 0 h32" opacity="0.4"/>
			<path class="ink-fine" d="M704 478 h40 m12 0 h28 m14 0 h52 m10 0 h36 m16 0 h40" opacity="0.3"/>
			<path class="ink-fine" d="M716 496 h30 m16 0 h44 m12 0 h34 m14 0 h48 m10 0 h30" opacity="0.22"/>
			<path class="ink-fine" d="M708 524 h36 m14 0 h30 m16 0 h48 m12 0 h32 m14 0 h38" opacity="0.16"/>
			<path class="ink-fine" d="M720 556 h28 m18 0 h42 m10 0 h36 m16 0 h44" opacity="0.11"/>
			<path class="ink-fine" d="M712 592 h40 m14 0 h30 m12 0 h50 m10 0 h34" opacity="0.07"/>
			<path class="ink-fine" d="M780 650 h32 m14 0 h40 m12 0 h36 m10 0 h28" opacity="0.05"/>
			<path class="ink-fine" d="M800 730 h28 m16 0 h36 m12 0 h40" opacity="0.04"/>
			<path class="ink-fine" d="M820 830 h30 m14 0 h34 m10 0 h30" opacity="0.03"/>
		</g>
	</g>

	<!-- One pair of gulls, high and small. Round 1 called birds a trope and
	     wanted them gone; ruling: three was decoration, one is an observation.
	     The station named a seal the Commissioner — this world keeps small
	     life in it, sparingly. -->
	<path class="ink-fine" d="M640 -240 q6 -6 12 0 q6 -6 12 0 M676 -222 q5 -5 10 0 q5 -5 10 0" opacity="0.4"/>

	<!-- ═══ THE POINT (rock mass: two hatch passes fading to bare paper) ═══ -->
	<g mask="url(#rockfade)">
		<path d="M0 920 L0 470 Q40 452 70 440 Q120 424 150 418 L150 400 L430 400 L430 402 Q500 398 560 405 L660 412 Q700 418 700 430 L760 452 Q850 488 960 516 L960 920 Z"
			fill="url(#rockhatch)"/>
		<path d="M0 920 L0 470 Q40 452 70 440 Q120 424 150 418 L150 400 L430 400 L430 402 Q500 398 560 405 L660 412 Q700 418 700 430 L760 452 Q850 488 960 516 L960 920 Z"
			fill="url(#rockhatch2)"/>
	</g>
	<!-- The terrain contour is the drawn line; the mass below is only hatch.
	     Heavy weight (Gemini round 2): the ground must anchor the buildings,
	     not read thinner than the walls it carries. -->
	<path class="ink-heavy" d="M0 470 Q40 452 70 440 Q120 424 150 418 L150 400 L430 400 M430 402 Q500 398 560 405 L660 412 Q700 418 700 430 L760 452 Q850 488 960 516"/>
	<!-- Hand strokes clustered where rock meets story: the cliff shoulder and
	     the tower's footing — irregular on purpose, the draughtsman's wrist. -->
	<path class="ink-fine" d="M74 452 l16 -7 M60 464 l20 -8 M92 470 l14 -6 M110 448 l12 -5 M128 462 l16 -6 M146 440 l10 -4 M136 478 l18 -7 M158 458 l12 -5 M700 444 l14 8 M718 460 l16 9 M736 452 l12 7 M756 470 l14 8 M772 484 l16 9" opacity="0.5"/>
	<!-- The sorrel lichen: the rock's one warm stain, tiny, almost missable. -->
	<path class="ink-fine" d="M96 442 q6 -5 12 -1 m-30 8 q5 -4 10 -1" stroke="var(--signal)" opacity="0.5"/>

	<!-- ═══ THE TOWER (cut open: lamp, watch, stairs, base, cellar) ═══ -->
	<g id="tower">
		<!-- Cut walls: outer taper heavy (sectioned masonry carries the plate's
		     darkest line), inner face fine — the wall has thickness. -->
		<path class="ink-heavy" d="M160 140 L145 400 M220 140 L235 400"/>
		<path class="ink-fine" d="M166 140 L152 400 M214 140 L228 400"/>
		<!-- Lamp room + roof + gallery -->
		<rect class="ink-heavy" x="160" y="72" width="60" height="58"/>
		<path class="ink-heavy" d="M160 72 Q190 44 220 72"/>
		<line class="ink" x1="190" y1="52" x2="190" y2="40"/>
		<line class="ink" x1="145" y1="130" x2="253" y2="130"/>
		<path class="ink-fine" d="M145 112 L145 130 M163 112 L163 130 M235 112 L235 130 M253 112 L253 130 M145 112 L253 112"/>
		<!-- The lens: a small diamond on its pedestal; glow when lit. -->
		<circle id="lampglow" cx="190" cy="100" r="17" fill="var(--lamp)"/>
		<path class="ink" d="M190 88 L200 100 L190 112 L180 100 Z M186 112 h8 v6 h-8 Z"/>
		<!-- Floors of the cut interior -->
		<line class="ink" x1="163" y1="210" x2="217" y2="210"/>
		<line class="ink" x1="152" y1="330" x2="228" y2="330"/>
		<!-- The stair: a zigzag between watch and base — where time is spent. -->
		<path class="ink-fine" d="M170 216 h14 v10 h14 v10 h-14 v10 h14 v10 h-14 v10 h14 v10 h-14 v10 h14 v10 h-14 v10 h14 v10 h-14"/>
		<!-- Watch room furniture: the desk and THE LOG on it, weather glass. -->
		<path class="ink-fine" d="M196 200 h20 v10 M199 196 h9 M203 191 l0 -6 a3 3 0 1 1 0 -0.1"/>
		<!-- Tower door to the cottage side, and down to the cellar. -->
		<path class="ink" d="M228 372 h24 M170 400 v-22 a10 10 0 0 1 20 0 v22"/>
		<!-- The cellar: cut into rock below grade; the nailed door. -->
		<rect class="ink" x="163" y="418" width="54" height="46"/>
		<path class="ink-fine" d="M163 418 l54 46 M217 418 l-54 46"/>
	</g>

	<!-- ═══ THE COTTAGE (cut: quarters, store, workshop) ═══ -->
	<g id="cottage">
		<path class="ink-heavy" d="M265 400 L265 332 L347 296 L430 332 L430 400"/>
		<path class="ink-fine" d="M265 332 L347 300 L430 332"/>
		<!-- Interior partitions -->
		<line class="ink" x1="322" y1="336" x2="322" y2="400"/>
		<line class="ink" x1="372" y1="336" x2="372" y2="400"/>
		<line class="ink-fine" x1="265" y1="400" x2="430" y2="400"/>
		<!-- Quarters: bed and the fire whose flue tells the truth. -->
		<path class="ink-fine" d="M270 392 h30 v-8 h-30 Z M303 400 v-16 h10 v16"/>
		<!-- Store: shelves and tins. -->
		<path class="ink-fine" d="M328 352 h38 M328 366 h38 M328 380 h38 M332 348 v4 M340 348 v4 M352 362 v4 M344 376 v4 M358 376 v4"/>
		<!-- Workshop: the bench, and the long rods behind the door. -->
		<path class="ink-fine" d="M378 388 h44 v-6 h-44 Z M424 400 l-2 -52 M420 400 l-2 -52"/>
		<!-- Chimney above the quarters' fire. -->
		<path class="ink" d="M300 306 v-40 h13 v34"/>
		<g id="smoke">
			<path class="ink-fine" d="M306 262 q-6 -12 2 -22 q8 -10 2 -22" />
		</g>
	</g>

	<!-- ═══ THE YARD (walled, exposed — where storms collect their toll) ═══ -->
	<path class="ink-fine" d="M430 400 h10 v-18 h-10 M560 405 h-10 v-18 h10" />
	<path class="ink-fine" d="M440 386 h110" opacity="0.5"/>

	<!-- ═══ THE SIREN HOUSE ═══ -->
	<g id="sirenhouse">
		<path class="ink-heavy" d="M560 410 L560 362 L605 344 L650 362 L650 410 Z"/>
		<!-- The horn faces the sea; the compressor squats inside. -->
		<path class="ink" d="M650 370 q26 -4 34 8 l-6 4 q-10 -9 -28 -6"/>
		<path class="ink-fine" d="M572 400 h28 v-16 h-28 Z M586 384 v-8 a8 8 0 0 1 8 0 v8"/>
	</g>

	<!-- ═══ THE BOATHOUSE & SLIPWAY ═══ -->
	<g id="boathouse">
		<path class="ink-heavy" d="M660 425 L660 382 L720 366 L780 382 L780 425"/>
		<path class="ink-fine" d="M700 470 L820 502 M712 464 L832 496"/>
		<path class="ink-fine" d="M672 418 q22 -10 44 0 q-22 6 -44 0 Z"/>
	</g>

	<!-- ═══ WEATHER, LIGHT, AND THE KEEPER (the living layers) ═══ -->
	<g id="beam"><path d="M190 100 L760 -120 L760 200 Z" fill="url(#beamfade)"/></g>
	<rect id="stormwash" x="0" y="-540" width="960" height="1500" fill="var(--ink)"/>
	<g id="rain">
		<path class="ink-fine" d="M80 60 l-6 16 M180 40 l-6 16 M290 90 l-6 16 M420 50 l-6 16 M540 100 l-6 16 M660 60 l-6 16 M790 110 l-6 16 M880 70 l-6 16 M120 200 l-6 16 M350 180 l-6 16 M600 210 l-6 16 M840 240 l-6 16 M230 260 l-6 16 M480 280 l-6 16 M720 300 l-6 16 M140 -80 l-6 16 M340 -140 l-6 16 M560 -60 l-6 16 M780 -180 l-6 16 M900 -40 l-6 16 M240 -200 l-6 16 M660 -120 l-6 16 M60 -160 l-6 16 M460 -220 l-6 16" opacity="0.6"/>
	</g>
	<rect id="fog" x="0" y="-540" width="960" height="1500" fill="var(--paper)"/>

	<!-- The keeper: one small figure; the drawing's only person. -->
	<g id="keeper">
		<circle class="ink" cx="0" cy="-19" r="3.4"/>
		<path class="ink" d="M0 -15 L0 -6 M0 -6 L-4 2 M0 -6 L4 2 M-4 -12 L4 -11"/>
	</g>`;

	// State surface — the game layer's four verbs, plus first-paint defaults.
	const api = {
		setWeather(w) { svg.dataset.weather = w; },
		setLamp(lit) {
			svg.dataset.lamp = lit ? 'lit' : 'dark';
			// The page-wide accent drain: the UI's warmth is the lamp's.
			document.documentElement.dataset.lamp = lit ? 'lit' : 'dark';
		},
		setFlue(state) { svg.dataset.flue = state; },
		setKeeper(room) {
			const [x, y] = ANCHORS[room] ?? ANCHORS.watch;
			svg.querySelector('#keeper').style.transform = `translate(${x}px, ${y}px)`;
		},
	};
	api.setWeather('clear');
	api.setLamp(true);
	api.setFlue('half');
	api.setKeeper('watch');
	return api;
}
