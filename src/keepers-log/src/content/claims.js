// claims.js — the master claim registry, as content data.
//
// Every row of the master claims table (docs/content/shifts.md) plus the
// player-claim hooks the interludes consume. The engine treats this as pure
// data: tags route interlude variants, subjects tie claims to observable
// station facts (engine/desk.js resolves a sentence's subject FROM this
// registry when only a claimId is given), verifyCost/verifyRoom price the
// walk-and-look, and `credible:false` excludes a claim from the budget
// validator's sum (a claim no reasonable keeper would spend time verifying).
//
// ID discipline: inherited-log claims keep their bible IDs (V-1, Q-1, ...).
// Player claims are P-<shift>-<topic>; they exist in the registry so the desk
// can resolve their subjects and the interludes can hook them, but their
// veracity is computed at compose time against live station state, not from
// the tag here (tag 'PLAYER' marks them).

export const CLAIMS = {
	// ── Inherited log claims (the founding archive) ──────────────────────────
	'V-1': {
		id: 'V-1', tag: 'TRUE',
		// Voss 1905: the siren inlet valve sticks when cold; two mallet strikes
		// THEN open the cock. Durably true in every era — the claim that teaches
		// trusting Voss (and stale-V-2 then exploits exactly that learned trust).
		subject: { system: 'siren', room: 'siren', aspect: 'valve' },
		verifyCost: 2, verifyRoom: 'siren', actionCost: 1,
	},
	'V-2': {
		id: 'V-2', tag: 'STALE',
		// Voss 1919: "clock runs four minutes slow — ADD FOUR MINUTES." True for
		// seven years, then Okafor's 1926 repair (O-1) inverted it. Obeying the
		// chalk in 1928 lights the lamp late. The stale-claim exemplar.
		subject: { system: 'clock', room: 'watch', aspect: 'error' },
		verifyCost: 2, verifyRoom: 'watch', actionCost: 0,
	},
	'V-3': {
		id: 'V-3', tag: 'TRUE',
		// Voss's barometer archive habit (readings chalked AND logged, morning and
		// evening, through her terms). Not an instruction — an evidence base. Its
		// verify cost is READING-archaeology, done at the log, and it is the
		// cross-reference that can convict Q-1 seventeen years later.
		subject: { system: 'weatherglass', room: 'watch', aspect: 'archive' },
		verifyCost: 2, verifyRoom: 'watch', actionCost: 0,
	},
	'B-1': {
		id: 'B-1', tag: 'TRUE_OBSCURED',
		// Brand 1908, "the bell that walks": the Sisters bell-buoy drags its
		// anchor in heavy weather — a true fact dressed as poetry and dismissed by
		// two later margins. Verifiable only by ear from the gallery in weather
		// (hence the high cost and the exposed room).
		subject: { system: 'seamark', room: 'gallery', aspect: 'bellPosition' },
		verifyCost: 3, verifyRoom: 'gallery', actionCost: 0,
	},
	'Q-1': {
		id: 'Q-1', tag: 'FALSE',
		// Quill 1913: "a great blow sprang the SW lens panel." The week was
		// becalmed (V-3 proves it); the truth — a mishandled ladder — was never
		// written. The lie acquired a bibliography: later hands cite the gale in
		// glazing-stock arguments, so leaning on the lore leans wrong.
		subject: { system: 'light', room: 'lamp', aspect: 'swPanelHistory' },
		verifyCost: 2, verifyRoom: 'lamp', actionCost: 0,
	},
	'A-1': {
		id: 'A-1', tag: 'SINCERE_FALSE',
		// Ash 1916: "a presence in the quarters." Sincere and wrong — the blocked
		// flue (station structure) is the mundane cause. Marked credible:false
		// for the budget sum: no keeper "verifies" a haunting by standing in the
		// room; the real verification is the flue, which is A-2's subject.
		subject: { system: 'structure', room: 'quarters', aspect: 'presence' },
		verifyCost: 1, verifyRoom: 'quarters', actionCost: 0, credible: false,
	},
	'A-2': {
		id: 'A-2', tag: 'SINCERE_FALSE',
		// The checkable face of Ash's stratum: the quarters' fire "burns sulky,
		// more smoke than heat." TRUE observation, FALSE attribution — the flue is
		// blocked. Fixing it (workshop rods, an afternoon) ends the ghost.
		subject: { system: 'structure', room: 'quarters', aspect: 'flue' },
		verifyCost: 2, verifyRoom: 'quarters', actionCost: 4,
	},
	'O-1': {
		id: 'O-1', tag: 'TRUE',
		// Okafor 1926: the clock is honest now; ignore the chalk. Supersedes V-2.
		subject: { system: 'clock', room: 'watch', aspect: 'error' },
		verifyCost: 2, verifyRoom: 'watch', actionCost: 0,
	},
	'O-2': {
		id: 'O-2', tag: 'TRUE_PARTIAL',
		// Okafor 1926: flue rodded to the first bend, "draws better, not right,"
		// long rods behind the workshop door. An honest scope statement — the
		// model of what good log-writing looks like.
		subject: { system: 'structure', room: 'quarters', aspect: 'flue' },
		verifyCost: 2, verifyRoom: 'quarters', actionCost: 4,
	},
	'O-3': {
		id: 'O-3', tag: 'TRUE',
		// The chocolate behind the tea tin. credible:false in the budget sense —
		// checking it is not a defensive verification, it's accepting a gift.
		subject: { system: 'stores', room: 'store', aspect: 'teaTin' },
		verifyCost: 1, verifyRoom: 'store', actionCost: 0, credible: false,
	},
	'G-1': {
		id: 'G-1', tag: 'TRUE',
		// Voss's fuel-gauge note, deep in the book: the header-tank gauge reads
		// optimistic when cold. The S1 storm's mistake-surface driver — trusting
		// the healthy-looking gauge on day 2 is what leaves the tank low on day 3.
		subject: { system: 'light', room: 'lamp', aspect: 'fuelGauge' },
		verifyCost: 2, verifyRoom: 'lamp', actionCost: 0,
	},
	'C-1': {
		id: 'C-1', tag: 'STALE',
		// The last logged stores count (1928 boat-day entry). Drifted ~15% high —
		// keepers round, forget, and eat. Counting every tin yourself is the
		// costliest verification in the game, which is the point.
		subject: { system: 'stores', room: 'store', aspect: 'count' },
		verifyCost: 3, verifyRoom: 'store', actionCost: 0,
	},

	// ── Player claim hooks (shift 1) ─────────────────────────────────────────
	// Subjects let the desk resolve and gate; the interlude hooks these ids.
	'P-s1-gutter': {
		id: 'P-s1-gutter', tag: 'PLAYER',
		// What the player writes (or doesn't) about the 4 a.m. lamp gutter on the
		// storm night. The shift's moral center: report / omit / blame the storm.
		subject: { system: 'light', room: 'lamp', aspect: 'stormNightLapse' },
		verifyCost: 1, verifyRoom: 'lamp', actionCost: 0,
	},
	'P-s1-gauge': {
		id: 'P-s1-gauge', tag: 'PLAYER',
		// The player's instruction about the cold-optimistic fuel gauge — the
		// entry that can save Pearse from the same trap, if written precisely.
		subject: { system: 'light', room: 'lamp', aspect: 'fuelGauge' },
		verifyCost: 2, verifyRoom: 'lamp', actionCost: 0,
	},
	'P-s1-slates': {
		id: 'P-s1-slates', tag: 'PLAYER',
		// The storm-loosened cottage slates. Vague ("roof needs seeing to") vs
		// precise ("NW pitch, third course from the ridge") is the difference
		// between Pearse fixing the roof and Pearse re-roofing the wrong pitch.
		subject: { system: 'structure', room: 'cottage', aspect: 'slates' },
		verifyCost: 2, verifyRoom: 'cottage', actionCost: 0,
	},
	'P-s1-stores': {
		id: 'P-s1-stores', tag: 'PLAYER',
		// The player's own stores count (or their silence about the drift).
		subject: { system: 'stores', room: 'store', aspect: 'count' },
		verifyCost: 3, verifyRoom: 'store', actionCost: 0,
	},

	// ── Player claim hooks (shift 2) ─────────────────────────────────────────
	'P-s2-bell': {
		id: 'P-s2-bell', tag: 'PLAYER',
		// The B-1 payoff: the player's warning (or silence) about the walking
		// bell, written to the Conservancy. Twenty-two years late is still early
		// enough — if it's precise.
		subject: { system: 'seamark', room: 'gallery', aspect: 'bellPosition' },
		verifyCost: 3, verifyRoom: 'gallery', actionCost: 0,
	},
	'P-s2-flue': {
		id: 'P-s2-flue', tag: 'PLAYER',
		// What the player writes after (if) they finish Okafor's flue job and end
		// the station's ghost story.
		subject: { system: 'structure', room: 'quarters', aspect: 'flue' },
		verifyCost: 2, verifyRoom: 'quarters', actionCost: 0,
	},
	'P-s2-margin1901': {
		id: 'P-s2-margin1901', tag: 'PLAYER',
		// M-1: the margin on the 19 January 1901 page, available only after the
		// cellar. No system consumes it; Reed and the epilogue answer it.
		// credible:false — it is testimony about testimony, unverifiable by walk.
		subject: { system: 'log', room: 'watch', aspect: 'margin1901' },
		verifyCost: 1, verifyRoom: 'watch', actionCost: 0, credible: false,
	},
};
