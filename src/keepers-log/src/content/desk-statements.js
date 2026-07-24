// desk-statements.js — the composable statements and their frozen texts.
//
// The desk's contract (engine/desk.js): each offered statement is a spec
// { statementId, claimId, certainty, assertedValue? } and the TEXT is looked
// up from TEMPLATES keyed `${statementId}|${certainty}` — frozen verbatim at
// compose time so downstream quoting is byte-exact. A "lie" is its own
// statementId with its own fixed text and assertedValue: the desk computes
// veracity against ground truth, so the same UI list can offer honest and
// dishonest phrasings without the engine knowing which is which until it
// checks the world.
//
// Register note (the authorship layer): these are the player-keeper's
// available VOICES, and they deliberately span the book's own registers —
// the precise options sound like Voss/Okafor, the vague ones like a tired
// hand, the self-serving ones like Quill without ever naming him. The game
// never labels a lie; the phrasing is simply available, the way it was
// available to Quill.
//
// Observation gating is the engine's job: 'precise' options only unlock when
// the matching fact was observed THIS shift (engine/desk.js statementOptions).
// The UI offers what the gate allows; these tables define what exists.

// ── Shift 1 — the storm shift's writable subjects ──────────────────────────
export const S1_STATEMENTS = [
	{
		// The moral center: the 4 a.m. gutter nobody saw. Three phrasings of the
		// same night — report, shade, or blame the weather. The omission "option"
		// is the absence of all three (engine detects omission as no sentence).
		subjectLabel: 'The storm night',
		options: [
			{ statementId: 's1-gutter-honest', claimId: 'P-s1-gutter', certainty: 'precise', assertedValue: 'guttered' },
			{ statementId: 's1-gutter-vague', claimId: 'P-s1-gutter', certainty: 'vague' },
			{ statementId: 's1-gutter-blame-storm', claimId: 'P-s1-gutter', certainty: 'precise', assertedValue: 'storm-doused' },
		],
	},
	{
		subjectLabel: 'The fuel gauge',
		options: [
			{ statementId: 's1-gauge-precise', claimId: 'P-s1-gauge', certainty: 'precise', assertedValue: 'cold-optimistic' },
			{ statementId: 's1-gauge-vague', claimId: 'P-s1-gauge', certainty: 'vague' },
		],
	},
	{
		subjectLabel: 'The cottage roof',
		options: [
			{ statementId: 's1-slates-precise', claimId: 'P-s1-slates', certainty: 'precise', assertedValue: 'nw-third-course' },
			{ statementId: 's1-slates-vague', claimId: 'P-s1-slates', certainty: 'vague' },
		],
	},
	{
		subjectLabel: 'Stores',
		options: [
			// assertedValue is the NUMBER the sentence asserts, matching the
			// ground truth SYSTEMS_INITIAL.stores.count — the contract the
			// 2026-07-24 playtest caught this option violating ('counted-true'
			// vs 34 tagged the honest count FALSE and routed it to a Pearse
			// variant that doesn't exist). The template says THIRTY-FOUR; the
			// data must say 34.
			{ statementId: 's1-stores-counted', claimId: 'P-s1-stores', certainty: 'precise', assertedValue: 34 },
			{ statementId: 's1-stores-aslogged', claimId: 'P-s1-stores', certainty: 'guess', assertedValue: 41 },
		],
	},
];

// ── Shift 2 — being read ───────────────────────────────────────────────────
export const S2_STATEMENTS = [
	{
		subjectLabel: 'The Sisters bell',
		options: [
			{ statementId: 's2-bell-warning', claimId: 'P-s2-bell', certainty: 'precise', assertedValue: 'drags-east' },
			{ statementId: 's2-bell-vague', claimId: 'P-s2-bell', certainty: 'vague' },
		],
	},
	{
		subjectLabel: 'The quarters flue',
		options: [
			{ statementId: 's2-flue-finished', claimId: 'P-s2-flue', certainty: 'precise', assertedValue: 'rodded-through' },
			{ statementId: 's2-flue-vague', claimId: 'P-s2-flue', certainty: 'vague' },
		],
	},
	{
		// Unlocked only after the cellar (flags.cellarOpened, wired at P4). One
		// certainty: there is no "precise" about the Trouble — that is the point.
		subjectLabel: 'A margin on the old pages',
		requiresFlag: 'cellarOpened',
		options: [
			{ statementId: 's2-margin-1901', claimId: 'P-s2-margin1901', certainty: 'vague' },
		],
	},
];

// ── The frozen texts ───────────────────────────────────────────────────────
// Key: `${statementId}|${certainty}`. These strings are what downstream
// keepers QUOTE, byte for byte. Punctuation is load-bearing.
export const TEMPLATES = {
	// S1 — the gutter
	's1-gutter-honest|precise':
		'In the worst of the blow, near four, the lamp guttered and stood dark some minutes before I had her back. The fault was mine in part: I trusted the header gauge the cold morning before, and the tank ran leaner than the glass confessed. A coaster passed distant in that hour. I do not know what she saw.',
	's1-gutter-vague|vague':
		'A hard night of it in the blow. Some trouble with the lamp toward morning, mastered by dawn.',
	's1-gutter-blame-storm|precise':
		'In the height of the storm the wind found the lamp itself and drove her down some minutes despite all attendance, as these towers in a great blow will suffer. Relit and burning strong by the four o’clock. No fault in the keeping of her.',

	// S1 — the gauge
	's1-gauge-precise|precise':
		'Mark this against a cold morning: the header gauge reads a comfortable HALF when the oil is cold and the truth is nearer a THIRD. An earlier hand painted the third on the dip-rule — trust the rule, not the glass, before any long night. I learned this the hard way in the blow of the 14th; you need not.',
	's1-gauge-vague|vague':
		'The fuel gauge wants watching in the mornings.',

	// S1 — the slates
	's1-slates-precise|precise':
		'The blow stripped slates from the COTTAGE ROOF, NORTHWEST PITCH, third course down from the ridge — five gone and two sprung, over the quarters’ window. Battened temporary with boathouse canvas. The pitch will want a ladder from the yard side and a dry day.',
	's1-slates-vague|vague':
		'The roof took some hurt in the storm and wants seeing to when weather allows.',

	// S1 — stores
	's1-stores-counted|precise':
		'Stores counted at the shelf this day, every tin handled: tinned meat THIRTY-FOUR (the book said forty-one; the book was wrong, or the mice are thorough), biscuit two boxes, oil at the autumn mark less what the blow burned, spirit two cans. Count is mine and current.',
	's1-stores-aslogged|guess':
		'Stores as per the last count in this book, no cause to doubt it.',

	// S2 — the bell
	's2-bell-warning|precise':
		'To the Conservancy, and to every keeper after me: the Sisters bell DRAGS ITS MOORING in heavy weather. I have heard it this term a half-mile east of the charted place, and an earlier hand heard the same twenty-two years ago and wrote it in this book, where it was laughed at in the margins for being written beautifully. It was written TRUE. A vessel working the strait by chart and bell in fog is steering on a mark that walks. Report made by the boat; letter copied here.',
	's2-bell-vague|vague':
		'The bell on the Sisters sounds odd-placed some nights. Worth an ear.',

	// S2 — the flue
	's2-flue-finished|precise':
		'The quarters’ flue is CLEAR. I took the long rods from behind the workshop door and finished what the keeper of 1926 began — the bend below the first defeated his rod and near defeated mine; a second jackdaw parish came out of it, older than the first. The fire draws honest now and the room keeps its warmth. Whatever was in that room these winters past, it is gone, and it was never anything a rod could not reach.',
	's2-flue-vague|vague':
		'Did some work on the quarters’ chimney. The room is better than it was.',

	// S2 — the margin (M-1). Composed as free-address; one register only.
	// Whatever the player writes in the optional personal note travels WITH
	// this statement — the margin is the one place the operational and
	// personal layers touch.
	's2-margin-1901|vague':
		'[Written small, in the margin of the page for 19 January 1901:] I have read the other account. Both of you are in this book now. That is all the justice a book can do, and I record that it is not enough, and that I believe you both.',
};
