// interludes.js — the authored consequence graph: Pearse (1929) and Reed
// (1931–33) acting on the player's words.
//
// Engine contract (engine/interlude.js): each load-bearing item routes by the
// player sentence's tags — precise-TRUE → 'followed', vague/guess →
// 'misread', precise-FALSE → 'propagated', no sentence at all → 'ambush' —
// and the selected variant's template gets the player's EXACT signed sentence
// spliced at {{quote}} (ambush quotes nothing; the absence is the point).
// Deltas patch station systems; nodeIds land in the consequence log and the
// finale's transfer record reads them.
//
// Voice notes (authorship): Pearse is brisk, literal, and keeps score — she
// reads instructions as written, not as meant, and her gratitude is as exact
// as her resentment. Reed is the honest median keeper: plain, unresentful,
// slightly tired; by his second term the player's precise fixes have become
// "how it is done" and their vague warnings have fully mutated. Neither
// voice editorializes the player. The consequences do that.
//
// ASSERTED-VALUE CONTRACT with day scripts: veracity is computed at compose
// time against station ground truth, so each statement's assertedValue in
// desk-statements.js must equal the system value the day scripts establish
// (see shifts-days.js SYSTEMS notes). A drift between those two files is a
// content bug the pipeline test catches.

export const PEARSE_INTERLUDE = {
	npcKeeperId: 'pearse',
	dateLabel: '1929, three terms',
	loadBearing: [
		{
			// THE GUTTER — the shift's moral center, all four branches reachable.
			claimHook: 'P-s1-gutter',
			variants: {
				followed: {
					// Honest report → the Ilsa's query letter finds an answered record.
					// The player's honesty converts a potential inquiry into a filed
					// nothing — and Pearse credits the hand that wrote it.
					template:
						'A letter this boat from the Conservancy: the master of the coaster Ilsa reported the light dark some minutes in the equinoctial blow of last autumn. The book had the answer waiting for them. The keeper before me wrote: “{{quote}}” — and the Board’s man has stamped the matter CLOSED, keeper’s report concurring with the master’s. A plain page saved this station a hearing. I have copied the letter into the back sleeve. — D.P.',
					delta: { conservancy: { ilsaQuery: 'closed-by-record' } },
					nodeId: 'pearse-gutter-honest-closed',
				},
				misread: {
					// A vague "some trouble with the lamp" answers nothing when the
					// question arrives — not as damning as silence, but close.
					template:
						'A letter this boat: the master of the coaster Ilsa reports the light dark some minutes on a night last autumn. I went to the book for the answer and found: “{{quote}}” — which tells the Board there was trouble and tells them nothing else, so now there is to be CORRESPONDENCE, which is what a keeper writes a log to prevent. I have answered with what the page gave me, which was little enough. — D.P.',
					delta: { conservancy: { ilsaQuery: 'open-correspondence' } },
					nodeId: 'pearse-gutter-vague-correspondence',
				},
				propagated: {
					// The Quill move, one era on: the lie is adopted as station lore and
					// grows procedure. Pearse builds on it in good faith — the error
					// compounds under a signature that never lied.
					template:
						'Reading in this term against the autumn gales: the keeper before me records — “{{quote}}” — a storm that could drive down a well-kept lamp. Very well: I have written the Conservancy for STORM SHUTTERS to the lamp-room glazing, as this station plainly draws a wind beyond the ordinary, and cited the page. The requisition stands granted. The fitting is to be done next season, at the Board’s cost, against a weather this book says we have. — D.P.',
					delta: { conservancy: { stormShutters: 'requisitioned-on-false-page' } },
					nodeId: 'pearse-gutter-lie-shutters',
				},
				ambush: {
					// Silence: the query arrives and the record shows nothing. Pearse
					// carries the cost and addresses the debt forward — the Voss page,
					// one generation on, aimed at YOU.
					template:
						'A letter this boat: the master of the coaster Ilsa reports the light dark some minutes on the night of the great blow last autumn. I have read every page of that month twice. The record shows NOTHING — a storm, a survey of slates, and no word of the lamp. So I have answered the Conservancy that the log is silent, which is an answer that shames the book and the hand that kept it. To that keeper, if ever you read this: I did not need you to be faultless. I needed you to be WRITTEN. — D.P.',
					delta: { conservancy: { ilsaQuery: 'open-record-silent' } },
					nodeId: 'pearse-gutter-omitted-ambush',
				},
			},
		},
		{
			// THE GAUGE — the player's chance to break the trap that caught them.
			claimHook: 'P-s1-gauge',
			variants: {
				followed: {
					template:
						'Cold morning, long night ahead, and the header glass swearing HALF. The keeper before me wrote: “{{quote}}” — so I took the dip-rule instead, found a third, and pumped before dark instead of during it. Adopted as my practice. A page that saves a night’s scramble is the book doing its work. — D.P.',
					delta: { light: { gaugePractice: 'dip-rule-adopted' } },
					nodeId: 'pearse-gauge-adopted',
				},
				misread: {
					// "Wants watching" — so Pearse watches it. Literally. The vague
					// warning produces vigilance without understanding: she watches the
					// wrong instrument more attentively.
					template:
						'The keeper before me left a line on the fuel: “{{quote}}” — so watch it I do, morning and evening, and this morning the glass said HALF and by the four o’clock the burner was starving and I was at the pump in a gale of my own making. WATCHING a liar closely does not make it honest. If there was more to know, it is not on the page. — D.P.',
					delta: { light: { gaugePractice: 'watched-not-understood' } },
					nodeId: 'pearse-gauge-vague-scramble',
				},
				ambush: {
					// Nothing written: Pearse meets the same cold-gauge trap raw. (Voss's
					// 1906 page exists deep in the book — but Pearse is not a deep
					// reader, and that is HER flaw compounding YOUR silence.)
					template:
						'Caught this morning by the header glass reading fat on a cold tank — pumping in the dark like a first-termer while the lamp leaned on her last inches. If any hand before me knew this station’s gauge for a cold-morning liar, they kept it to themselves or buried it pages deep. Marked NOW, in my hand, where the next will find it. — D.P.',
					delta: { light: { gaugePractice: 'relearned-the-hard-way' } },
					nodeId: 'pearse-gauge-omitted-relearn',
				},
			},
		},
		{
			// THE SLATES — precision as roof-craft. The bible's canonical misquote
			// beat: vague warning → the wrong pitch gets re-roofed.
			claimHook: 'P-s1-slates',
			variants: {
				followed: {
					template:
						'Dry spell this week, so the roof. The page before me is a work order in all but name: “{{quote}}” — northwest pitch, third course, and there the damage was, exact as charted. A morning with the ladder and the cottage is tight. The battening had held; the writing held better. — D.P.',
					delta: { structure: { slates: 'sound', roofLeak: null } },
					nodeId: 'pearse-slates-fixed-first-try',
				},
				misread: {
					// Executed as written, not as meant. She fixes A pitch — the wrong
					// one — and the leak stays. Bitterness at the page, not the person:
					// she never met them. Nobody here has ever met anybody.
					template:
						'Roof work this week, per the warning left me: “{{quote}}” — “seeing to,” then. I saw to it: went over the SOUTH pitch, the weather side any roofer would name first, re-set nine slates, half a day’s work done properly. And the quarters’ ceiling STILL weeps at the northwest corner in a blow. So the hurt is somewhere the page did not trouble to say, and the ladder goes up twice for one storm’s damage. Words cost nothing and mine here cost me a morning: SAY WHICH PITCH. — D.P.',
					delta: { structure: { slates: 'nw-third-course', roofLeak: 'quarters' } },
					nodeId: 'pearse-slates-wrong-pitch',
				},
				ambush: {
					template:
						'Found the quarters’ ceiling stained and the northwest pitch short five slates, sprung two — old damage, battened by a hand that plainly knew, for the canvas was boathouse canvas and neatly tied. Known, mended-temporary, and never written. The book has a survey of that storm in it and no roof in the survey. What else did that keeper know that I am living under? — D.P.',
					delta: { structure: { slates: 'nw-third-course', roofLeak: 'quarters' } },
					nodeId: 'pearse-slates-omitted-distrust',
				},
			},
		},
		{
			// STORES — the count. Precise-corrected → the book heals; as-logged
			// guess → the drift compounds into a short winter.
			claimHook: 'P-s1-stores',
			variants: {
				followed: {
					template:
						'Stores against the book on my landing: the last count reads — “{{quote}}” — a hand that counted at the SHELF and said so, and corrected the page before it. My own count agrees within a tin. The book and the shelf speak with one voice this term, which I am given to understand is not this station’s tradition. — D.P.',
					delta: { stores: { bookAccuracy: 'restored' } },
					nodeId: 'pearse-stores-book-healed',
				},
				misread: {
					// "As per the last count, no cause to doubt it" — the guess launders
					// the drift forward with fresh confidence. Pearse rations late.
					template:
						'Ran the stores against the book mid-term and found the meat SEVEN TINS short of the page. The page before me reads: “{{quote}}” — no cause to doubt it, says the hand, and so the doubt fell to me, in February, which is the month doubt costs most. Rationed the last fortnight to make the boat. The count in this book has been wrong since before my predecessor and every hand since has initialed it forward like a debt. COUNTED AT THE SHELF this day: meat twenty-nine, biscuit one box. The debt stops here. — D.P.',
					delta: { stores: { bookAccuracy: 'drift-compounded-then-corrected', februaryRation: true } },
					nodeId: 'pearse-stores-guess-ration',
				},
				ambush: {
					template:
						'Short of the book’s count by seven tins of meat at mid-term and no page anywhere owning it. Rationed the fortnight, made the boat, counted everything at the shelf and written it fresh. The book’s count is only as good as the last hand that touched tins and ink the same day. — D.P.',
					delta: { stores: { bookAccuracy: 'corrected-after-shortfall', februaryRation: true } },
					nodeId: 'pearse-stores-omitted-ration',
				},
			},
		},
	],
};

export const REED_INTERLUDE = {
	npcKeeperId: 'reed',
	dateLabel: '1931–1933, two terms',
	loadBearing: [
		{
			// THE BELL — B-1's payoff, two years on. The player's warning (or
			// silence) meets the coaster working the strait by chart and bell.
			claimHook: 'P-s2-bell',
			variants: {
				followed: {
					template:
						'Fog three days this week and the strait working. The Elsinore’s master put in at the landing to say his thanks to this station: he had the Conservancy’s NOTICE TO MARINERS on the Sisters bell aboard — the one that began as a page in this book: “{{quote}}” — and stood off the reef in fog on the strength of it, where his chart alone would have carried him onto the bell’s old grave. Two keepers wrote that warning a generation apart. The first was laughed at. It appears the sea was not laughing. — S.R.',
					delta: { seamark: { bellRecharted: true }, conservancy: { noticeToMariners: 'sisters-bell' } },
					nodeId: 'reed-bell-notice-near-miss-averted',
				},
				misread: {
					template:
						'A coaster took a fright in the fog Tuesday — heard the Sisters bell well east of where she reckoned it and sheered off in time, more luck than chart. There is a line in the book from the keeper two before me: “{{quote}}” — an ear’s worth of warning, and an ear is what it took. I have written the Conservancy plainly with positions and dates. It should not have waited for me, and it nearly did not wait at all. — S.R.',
					delta: { conservancy: { bellReport: 'sent-late-by-reed' } },
					nodeId: 'reed-bell-vague-near-thing',
				},
				ambush: {
					// Silence twice over — Brand's poem still moldering unindexed, and
					// the player, who READ it, adding nothing. The grounding scare and
					// the inquiry letter land in shift 3's lap.
					template:
						'Bad business in the fog Tuesday: the coaster Merrow touched on the Sisters’ east shoulder — off in one piece on the flood, no lives lost, her plates sprung. Her master swears by his chart and swears the bell lied, that it rang from east of its charted place. The Conservancy has opened an INQUIRY on the strait’s marks, this station’s book to be produced. I have read what there is to read. There is a poem. — S.R.',
					delta: { conservancy: { groundingInquiry: 'merrow-1932' }, seamark: { bellRecharted: false } },
					nodeId: 'reed-bell-silence-grounding',
				},
			},
		},
		{
			// THE FLUE — the fix fading into custom: attribution dissolves, the
			// good survives. The gentlest consequence in the game, on purpose.
			claimHook: 'P-s2-flue',
			variants: {
				followed: {
					template:
						'Cold snap this week and the quarters warm through it, fire drawing clean. The book says the flue was fought by three hands across ten years and finished by the one before me: “{{quote}}” — though I notice this term I am the first keeper in the record who never thought about that room at all. It is just the warm room now. That is what a finished job looks like in a book: one page, and then silence, and the silence is the thanks. — S.R.',
					delta: { structure: { flueFixed: true } },
					nodeId: 'reed-flue-finished-silence',
				},
				misread: {
					template:
						'The quarters are better than the old pages moan of, though the fire still sulks on a hard east wind. The hand before me left a line — “{{quote}}” — better, then, and not done, like most things here. Window cracked on high fires per the 1926 page, which remains the best advice in this book. — S.R.',
					delta: { structure: { flueFixed: false } },
					nodeId: 'reed-flue-partial-persists',
				},
				propagated: {
					// The cruelest lie in the game's reach: claiming Okafor's job
					// finished. Reed TRUSTS the page — moves into the quarters, shuts
					// the door against the cold, and inherits Ash's winter with a
					// clean conscience and a book that swears the room is safe.
					template:
						'Moved my sleeping to the quarters this winter on the strength of the book — the hand before me wrote: “{{quote}}” — and kept the door shut against the cold as a man may in a CLEAR-flued room. Three weeks of leaden mornings and an aching head and a dread I am ashamed to set down, till I began to think the oldest pages had the right of that room after all. Then a hard gust blew the fire back and the smoke came into the room like it knew the way. The flue is NOT clear. The rods stop where they always stopped, at the second bend. I have checked the page against the chimney twice now, and I record, with what charity I can find, that one of them is lying, and it is not the chimney. Sleeping in the chair. — S.R.',
					delta: { structure: { flueFixed: false, flueBookDiscredited: true } },
					nodeId: 'reed-flue-lie-inherited-ash',
				},
				ambush: {
					// Never touched, never mentioned: Ash's dread outlives another
					// keeper, now pure folklore. Reed sleeps in the chair and doesn't
					// know why. Nobody knows why anymore. THAT is a lost fact's ghost.
					template:
						'I keep to the watch-room chair these winter nights. Could not rightly say why — the keepers here always have, the book being full of dark remarks about the quarters in winter, and a man alone takes the custom of the house. Stiff neck all season. The quarters stand empty and warm-looking and no one sleeps there, and I suppose no one ever will, and I suppose none of us remembers the reason, if there was one. — S.R.',
					delta: { structure: { flueFixed: false } },
					nodeId: 'reed-flue-folklore-persists',
				},
			},
		},
		{
			// THE MARGIN (M-1) — found, or never written. The 'misread' key is
			// routing only: a margin is composed vague (there is no precise about
			// the Trouble), so it arrives here — and Reed's reading of it is not a
			// misreading at all. The graph's keys are mechanics; the prose is the
			// meaning. Ambush = the player never wrote it: Reed's entry is his
			// ordinary wear report, and the old pages keep their silence.
			claimHook: 'P-s2-margin1901',
			variants: {
				misread: {
					template:
						'Quiet term. In the long dark I read the whole book through, back to the two-hands pages before the Arrangement. Someone has written in the old pages — small, in the margin of the wreck winter: “{{quote}}”\nI read it twice. I have nothing to add. I record only that I closed the book gently, and stood the gallery a while though it was cold, and the light went out and out over the water same as it did for them. — S.R.',
					delta: {},
					nodeId: 'reed-margin-found',
				},
				ambush: {
					template:
						'Quiet term. Wear as expected of a station this age: the landing chain wants renewing within the year, the gallery rail is scaling, the lens drive runs true. In the long dark I read the old pages, the two-hands years, the wreck winter. Hard reading. The book goes silent where you most want a voice — but then it was not written for wanting. All well, or well enough. — S.R.',
					delta: {},
					nodeId: 'reed-margin-unwritten',
				},
			},
		},
	],
};
