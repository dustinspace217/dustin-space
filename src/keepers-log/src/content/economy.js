// economy.js — the time-unit economy, as content data.
//
// These are the tuning constants from docs/content/shifts.md ("Time economy"),
// kept as CONTENT rather than engine constants because they are authorial
// levers: the engine models structure (costs exist, days have budgets), the
// author decides magnitudes. The budget validator (engine/budget.js) proves
// against THESE numbers that no day can be fully verified — change a number
// here and the content-validation test re-proves or fails loudly.

export const ECONOMY = {
	// A waking day is 12 time-units (tu). Mandatory duties consume ~5 of them
	// (winding twice, lighting/dousing, a meal) — encoded per-day in the day
	// scripts' mandatoryTU so storm days can demand more.
	dayTU: 12,

	// Duty costs (tu each). Winding is cheap but must happen on rhythm; the
	// day scripts, not the engine, decide how often a day demands it.
	duty: {
		wind: 1,
		light: 1,
		douse: 1,
		meal: 1,
		soundSiren: 1,
		// Hand-pumping the header tank from the tower base is real work — two
		// hours of it. The cost IS the storm-day dilemma: on the 7-mandatory
		// storm day it eats 2 of 5 discretionary tu, so pumping "just in case"
		// competes with everything else the storm demands. A free pump would
		// erase the gutter's trade-off entirely (the ui-builder's flag #1 —
		// this number was the spec gap). The flue job's cost deliberately does
		// NOT live here — it is A-2.actionCost in claims.js, one source only.
		pumpFuel: 2,
	},

	// An unforced look at something you're standing next to. Claim
	// verifications override this with their own verifyCost (deeper checks
	// cost more — counting every tin is not glancing at a gauge).
	inspectCost: 1,

	// Reading one stratum of the log costs a session of attention. Reading is
	// deliberately cheap-but-not-free: the log is the game, but a keeper who
	// reads all day keeps no light.
	readLog: 1,

	// Sleep-debuff tu penalties applied by advanceDay the next morning.
	// 'fog' is Ash's real cause (the blocked flue, quarters with the door
	// shut); 'stiffness' is the watch-room chair. Fog costs more — that
	// asymmetry is what makes the flue worth fixing.
	debuffCost: {
		fog: 2,
		stiffness: 1,
	},
};
