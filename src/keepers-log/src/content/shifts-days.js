// shifts-days.js — the day scripts: weather, budgets, and live claims.
//
// Two consumers: engine advanceDay/advanceShift (day, weather, tu) and the
// budget validator (engine/budget.js — every day must PROVE that verifying
// all its live credible claims costs more tu than the day has spare; the
// content-validation test runs validateAllDays over this whole file, so an
// edit here that makes any day fully-verifiable fails CI loudly).
//
// "Live" = claims plausibly in play that day: surfaced by the beats, the
// pages the player is being led to, or the systems the day stresses. Live
// lists are a design statement — they are what a conscientious keeper would
// FEEL the pull to check that day, which is exactly the pull the budget must
// make unaffordable.
//
// GROUND-TRUTH CONTRACT (with desk-statements.js assertedValues — the
// pipeline/content tests enforce the pairs):
//   stores.count = 34            (the book's C-1 says 41 — drifted)
//   light.fuelGauge = 'cold-optimistic'
//   light.stormNightLapse = null, set 'guttered' by the S1 day-3 storm event
//   structure.slates = 'sound', set 'nw-third-course' by the same storm
//   seamark.bellPosition = 'drags-east'   (Brand was right, always was)
//   structure.flue = 'half-rodded', set 'rodded-through' only by the player
//     actually doing the S2 rod work (A-2/O-2's actionCost); the desk's
//     s2-flue-finished asserts 'rodded-through' — claiming it WITHOUT the
//     work tags FALSE and routes Reed's 'propagated' page. By design.
//   structure.flueFixed = false until the rod work completes (sleep() reads it)

export const SHIFT1_DAYS = [
	{
		id: 's1-d1', day: 1, weather: 'fog', dayTU: 12, mandatoryTU: 5,
		// Arrival + the clock question (V-2 chalk vs O-1 strike-through) + fog
		// demanding the siren (V-1) + the whole back-log calling to be read.
		liveClaims: ['V-2', 'O-1', 'V-1', 'C-1'],
	},
	{
		id: 's1-d2', day: 2, weather: 'clear', dayTU: 12, mandatoryTU: 5,
		// Stores day (C-1 count-or-trust) + the gauge reading healthy (G-1 deep
		// in the book) + glass falling (V-3's archive teaches what falling means
		// here) + the glazing lore (Q-1) if the player is reading around slates.
		liveClaims: ['C-1', 'G-1', 'V-3', 'Q-1'],
	},
	{
		id: 's1-d3', day: 3, weather: 'storm', dayTU: 12, mandatoryTU: 7,
		// THE STORM. Mandatory load is heavier (winding rhythm under pressure,
		// storm-gated outdoor legs). Live: the gauge trap springing (G-1), the
		// siren if the fog rides the front (V-1), and the bell walking in heavy
		// weather (B-1) for an ear that has read Brand. Events (engine-level
		// deltas, wired at P4): stormNightLapse -> 'guttered' at the 4 a.m. wind;
		// slates -> 'nw-third-course'.
		liveClaims: ['G-1', 'V-1', 'B-1'],
	},
	{
		id: 's1-d4', day: 4, weather: 'clear', dayTU: 12, mandatoryTU: 5,
		// Damage survey + the writing that matters. Live: the flue thread if the
		// survey reaches the quarters (A-2/O-2), the count's reckoning (C-1),
		// and Q-1 again as the glazing decision surfaces.
		liveClaims: ['A-2', 'O-2', 'C-1', 'Q-1'],
	},
];

export const SHIFT2_DAYS = [
	{
		id: 's2-d1', day: 1, weather: 'blow', dayTU: 12, mandatoryTU: 5,
		// Landing into Pearse's pages — her term is this shift's first reading,
		// and every thread she pulled reopens: the count, the gauge practice,
		// the glazing lore, the clock (still a new keeper's first question).
		liveClaims: ['C-1', 'G-1', 'Q-1', 'V-2', 'O-1'],
	},
	{
		id: 's2-d2', day: 2, weather: 'fog', dayTU: 12, mandatoryTU: 6,
		// FOG + the coaster working the strait: B-1's decades-late payoff. The
		// siren is wanted (V-1, mandatory load up), the gallery ear costs dear.
		liveClaims: ['B-1', 'V-1', 'V-3'],
	},
	{
		id: 's2-d3', day: 3, weather: 'clear', dayTU: 12, mandatoryTU: 5,
		// The dry day: flue work is POSSIBLE (A-2's actionCost), the cellar's
		// nails are one workshop crowbar away, and the barometer archaeology
		// (V-3 against Q-1) is a whole afternoon of reading if taken seriously.
		liveClaims: ['A-2', 'O-2', 'V-3', 'Q-1'],
	},
	{
		id: 's2-d4', day: 4, weather: 'fog', dayTU: 12, mandatoryTU: 6,
		// Fog again — the strait carries sound strangely, the bell question
		// will not stay answered, and the siren house is cold (V-1).
		liveClaims: ['B-1', 'V-1', 'A-1', 'C-1'],
	},
	{
		id: 's2-d5', day: 5, weather: 'clear', dayTU: 12, mandatoryTU: 5,
		// Boat eve: the shift's writing weighs everything touched this term.
		liveClaims: ['A-2', 'B-1', 'C-1', 'V-3'],
	},
];

export const SHIFT3_DAYS = [
	{
		id: 's3-d1', day: 1, weather: 'clear', dayTU: 12, mandatoryTU: 6,
		// Decommission day one: triage Reed's recorded wear (the chain, the
		// rail), the fitter about the place, crates on the landing. Everything
		// old is briefly live one last time — what gets fixed FOREVER.
		liveClaims: ['C-1', 'A-2', 'B-1'],
	},
	{
		id: 's3-d2', day: 2, weather: 'clear', dayTU: 12, mandatoryTU: 6,
		// The last night. The routine, once, in full knowledge. The clock, the
		// gauge, the valve — every old friend gets a hand laid on it whether
		// the budget approves or not; the budget, for the last time, does not.
		liveClaims: ['G-1', 'V-1', 'V-2', 'O-1'],
	},
];

export const ALL_DAYS = [...SHIFT1_DAYS, ...SHIFT2_DAYS, ...SHIFT3_DAYS];

// The ground-truth contract above, as data — single source for the P4 state
// builder AND the content tests (which pin desk assertedValues against these
// exact values so the two files cannot drift apart silently).
export const SYSTEMS_INITIAL = {
	stores: { count: 34 },
	light: { fuelGauge: 'cold-optimistic', stormNightLapse: null },
	structure: { slates: 'sound', flue: 'half-rodded', flueFixed: false },
	seamark: { bellPosition: 'drags-east' },
	clock: { error: 'honest-since-1926' },
	siren: { valve: 'sticks-cold' },
};

// What the S1 day-3 storm event does to the world (applied by the P4 event
// layer; tests use it to build post-storm state for desk composition).
export const S1_STORM_DELTAS = {
	light: { stormNightLapse: 'guttered' },
	structure: { slates: 'nw-third-course' },
};

// Shift-transition scripts for engine advanceShift: where and when each new
// keeper begins. Arrival is always the boathouse — the Rule lands you at the
// slipway the outgoing keeper just left.
export const SHIFT_SCRIPTS = [
	{ shift: 1, dateLabel: 'Autumn 1928', day: 1, tu: 12, weather: 'fog', room: 'boathouse' },
	{ shift: 2, dateLabel: 'Winter 1930', day: 1, tu: 12, weather: 'blow', room: 'boathouse' },
	{ shift: 3, dateLabel: 'Spring 1934', day: 1, tu: 12, weather: 'clear', room: 'boathouse' },
];
