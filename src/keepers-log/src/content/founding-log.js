// founding-log.js — the authored archive: the log the player inherits.
//
// CONTENT-SIDE ONLY (P3 structural decision): these entries never enter
// GameState.entries — the engine simulates only player and NPC-interlude
// entries. The founding log is what the BOOK shows and what readLog strata
// unlock; margins, strata, and index data live here because the UI needs
// them and the engine never does.
//
// Shape: each entry = { id, stratum, dateLabel, keeperId, hand, body,
// margins?, claimRefs? }. `hand` keys the per-voice typography variant
// (design-spec §8 — subtle CSS variants, not font soup). `claimRefs` ties a
// page to registry claims so the UI can wire "follow / inspect first"
// source-explicit actions from the page itself. `body` is verbatim prose —
// the bible (docs/content/founding-log.md) is the drafting surface; THIS
// file is what ships.
//
// Strata (readLog keys, oldest first): 'pair-era', 'trouble', 'rule-early'
// (1901-1913), 'rule-middle' (1914-1923), 'rule-late' (1924-1934). Reading a
// stratum costs a session (economy.readLog); the index (below) is the
// diegetic navigation QA F9 required — imperfect but fair.

export const STRATA = ['pair-era', 'trouble', 'rule-early', 'rule-middle', 'rule-late'];

export const FOUNDING_LOG = [
	// ═══ PAIR ERA (1894–1901) — two hands to a page ═══════════════════════════
	{
		id: 'fl-1897-04-14', stratum: 'pair-era', dateLabel: '14 April 1897',
		keeperId: 'mercer', hand: 'mercer-early',
		body: 'Wind backing SW, glass falling slow. Boat brought flour, wicks, and a letter for Callum which he has read four times at supper and not once aloud.\nLamp lit 7.40, all watches stood.',
		margins: [{ by: 'callum', text: 'Five times. — J.' }],
	},
	{
		id: 'fl-1897-04-15', stratum: 'pair-era', dateLabel: '15 April 1897',
		keeperId: 'callum', hand: 'callum',
		body: 'Mercer says the west bin wants tarring before autumn and Mercer is right, which is a burden on us both. A seal has taken up residency on the slipway and regards our boathouse as negotiable territory. I have named him the Commissioner. Lamp lit 7.38, all well, the Commissioner notwithstanding.',
		margins: [{ by: 'mercer', text: 'The bin is tarred. The Commissioner remains. — E.M.' }],
	},
	{
		id: 'fl-1899-11-02', stratum: 'pair-era', dateLabel: '2 November 1899',
		keeperId: 'callum', hand: 'callum',
		body: 'First hard blow of the winter and the tower sang for it, the way she does, one low note you feel in your teeth on the stairs. Edwin stood both dog watches so I could mend the landing chain, which is mended, and will outlast the both of us if the sea allows.\nThe Commissioner has not been seen since Tuesday. We do not speak of it.',
		margins: [{ by: 'mercer', text: 'He is back. 6 Nov. — E.M.' }],
	},
	{
		id: 'fl-1900-06-21', stratum: 'pair-era', dateLabel: '21 June 1900',
		keeperId: 'mercer', hand: 'mercer-early',
		body: 'Midsummer. Lamp lit 9.12, the latest of the year, and the two of us sat the gallery an hour after dousing with the tea going cold, which the Conservancy does not pay us for and may bill me.\nAll well. It is a good station. I will put that down while it is easy to write: it is a good station.',
	},

	// ═══ THE TROUBLE — January 1901 ═══════════════════════════════════════════
	{
		id: 'fl-1901-01-19', stratum: 'trouble', dateLabel: '19 January 1901',
		keeperId: 'mercer', hand: 'mercer-early',
		body: 'Storm from the NNE by middle evening, the worst of this winter. I stood first watch. Lamp lit 4.55, burning strong at my relief. I gave the watch to Callum at midnight with the weights full wound and the glass still falling.\nAt 3 or a little after I woke to the horn of a vessel very near and no beam crossing my window. I went up. The lamp was out and Callum was not in the watch room. I relit — ten minutes, perhaps twelve. She was already on the Sisters. We got four men off the rocks by line before dawn. Eleven are not got off.\nCallum says the lamp was burning when he left the watch room. He says he left it only briefly, being taken ill. That is what he says.',
	},
	{
		id: 'fl-1901-torn', stratum: 'trouble', dateLabel: '[undated]',
		keeperId: 'unknown', hand: 'system',
		body: '[The following leaf is torn out. The stub carries three words in J.C.’s hand: “— not how it —”]',
	},
	{
		id: 'fl-1901-02-02', stratum: 'trouble', dateLabel: '2 February 1901',
		keeperId: 'mercer', hand: 'mercer-early',
		body: 'The Board’s men have taken the log for copying, and taken Callum on the same boat. What was salvaged of the Corminster’s people’s effects is put in the north cellar until claimed, the door to be nailed, by instruction. Item: the inquiry did not find against either keeper. Item: it did not find for either keeper. Item: I am to keep on alone until the new arrangement.\nThe lamp was burning when I gave over the watch. I will write that as often as it wants writing.',
	},
	{
		id: 'fl-1901-03-30', stratum: 'trouble', dateLabel: '30 March 1901',
		keeperId: 'conservancy', hand: 'system',
		// The Rule, in the institution's own cold grammar — the liability reframe
		// (design-spec §2, consensus F5). It solves blame-assignment, not truth,
		// and it says so if you read it the way it was written.
		body: 'BY ORDER OF THE CONSERVANCY OF LIGHTS. From the first of May the station will be kept by ONE keeper to a term, relieved by boat, the outgoing keeper to depart before the incoming keeper lands. There is to be ONE custodian of the light and ONE hand in the instrument of record for any hour the Board may examine. Terms are shortened accordingly. The log is the sole and sufficient witness of the station.\nThe arrangement of watches that obtained heretofore is discontinued.',
	},

	// ═══ RULE, EARLY (1901–1913) ══════════════════════════════════════════════
	{
		id: 'fl-1904-11-07', stratum: 'rule-early', dateLabel: '7 November 1904',
		keeperId: 'mercer', hand: 'mercer-late',
		body: 'Lamp lit 4.31 by the watch-room clock, which I set against the boat’s chronometer this morning, error one minute fast, corrected. Weights wound 4.35, 10.40, 4.50. Oil at the header, two hands and a thumb above the low mark, measured by rule, nine and one quarter inches. Wind NE 4, dry. No vessel in the strait between lighting and my going down.\nNothing further.',
	},
	{
		id: 'fl-1905-03-03', stratum: 'rule-early', dateLabel: '3 March 1905',
		keeperId: 'voss', hand: 'voss', claimRefs: ['V-1'],
		body: 'Fog since dawn. Compressor started stiff; the inlet valve sticks when the house is cold, which in this place is always. Remedy, proven this morning and twice since: two firm strikes with the small brass mallet (kept now on the hook above the gauge, where it will stay if keepers have sense) on the valve body, THEN open the cock. Not the reverse. The reverse wastes air and the morning.\nSounded the horn through to midday. Item for whoever follows: the mallet is the remedy. Do not send for parts. There is nothing wrong with the valve that warmth would not fix, and we cannot afford warmth.',
	},
	{
		id: 'fl-1906-08-19', stratum: 'rule-early', dateLabel: '19 August 1906',
		keeperId: 'voss', hand: 'voss', claimRefs: ['G-1'],
		body: 'Boat day. Stores landed and counted at the slipway against the manifest: correct save one stove-in tin of biscuit, noted, not charged.\nItem, for the book because it caught me and will catch another: the header-tank gauge in the lamp room reads a comfortable HALF when the morning is cold and the truth is nearer a THIRD. The float sits sluggish in cold oil. Trust the dip-rule, not the glass, before any long night. I have painted a line on the rule at the third.',
	},
	{
		id: 'fl-1908-06-02', stratum: 'rule-early', dateLabel: '2 June 1908',
		keeperId: 'brand', hand: 'brand',
		body: 'The light breathes tonight. Out and out over the water goes its one long syllable, and the sea says nothing back, which from the sea is courtesy.\nI have wound its heart at the hours appointed. Let the record show the darkness was contested.',
		margins: [{ by: 'voss', text: 'Weights, oil, weather NOT recorded. See almanac for what this keeper’s month should have contained.' }],
	},
	{
		id: 'fl-1908-06-14', stratum: 'rule-early', dateLabel: '14 June 1908',
		keeperId: 'brand', hand: 'brand', claimRefs: ['B-1'],
		body: 'The bell on the Sisters has learned to walk. Three nights I have heard it toll east of where the chart pins it, a half-mile of wandering, as if the reef grew restless in the swell. A bell should keep its grave. This one paces on it.\nNo vessel troubled. The light exact. The walking bell alone to report.',
		margins: [
			{ by: 'quill', text: 'The bell is where the chart says. Checked from the gallery on a clear noon. — M.Q.' },
			{ by: 'unknown-1919', text: 'See previous keeper’s remarks, if remarks they are.' },
		],
	},
	{
		id: 'fl-1911-02-27', stratum: 'rule-early', dateLabel: '27 February 1911',
		keeperId: 'quill', hand: 'quill',
		body: 'Took the station over in good order from the meticulous hand before me, whose lists I will do my best to live up to and whose cat I regret to report the Conservancy still has not sent.\nBlow from the west two days, no damage, lamp all correct. A station keeps you honest: the sea reads the log every night and files no complaints so long as the light answers.',
	},
	{
		id: 'fl-1913-02-08', stratum: 'rule-early', dateLabel: '8 February 1913',
		keeperId: 'quill', hand: 'quill', claimRefs: ['Q-1'],
		body: 'A great blow in the night, from clear into half a gale by the second watch, and at dawn I find the SW lens panel sprung and cracked across, glass worked loose by the wind’s working as the tower shivered. Puttied and papered temporary, spare panel wanted by next boat, letter written. No fault found in the mounting, the storm alone the author.\nLamp burning throughout on the remaining panels, none the wiser at sea.',
	},
	{
		id: 'fl-1913-02-11', stratum: 'rule-early', dateLabel: '11 February 1913',
		keeperId: 'quill', hand: 'quill',
		// The lie, consolidating. Three days later, unprompted — the tell no one
		// read: honest men don't re-argue what nobody questioned.
		body: 'Glazier’s letter gone with the boat. For the file: the panel was sound at my last dusting of it, the week previous. Wind is the only hand that touched it. These towers work in a gale like a ship works, any keeper will say so.\nAll else correct.',
	},

	// ═══ RULE, MIDDLE (1914–1923) ═════════════════════════════════════════════
	{
		id: 'fl-1916-12-05', stratum: 'rule-middle', dateLabel: '5 December 1916',
		keeperId: 'ash', hand: 'ash-early', claimRefs: ['A-2'],
		body: 'Cold beyond anything I have kept in. The quarters’ fire burns sulky and gives more smoke than heat; I have taken to keeping the door shut and the window sealed with list, and still the warmth leaks out of the room like it too wants off this rock.',
	},
	{
		id: 'fl-1916-12-19', stratum: 'rule-middle', dateLabel: '19 December 1916',
		keeperId: 'ash', hand: 'ash-middle', claimRefs: ['A-1'],
		body: 'Waking heavy these mornings, with an aching head, as if I had not slept but been somewhere, doing some work I am not told of. The fire watches me. I am aware of how that reads in a Conservancy book. I write what is so.',
	},
	{
		id: 'fl-1916-12-28', stratum: 'rule-middle', dateLabel: '28 December 1916',
		keeperId: 'ash', hand: 'ash-late', claimRefs: ['A-1'],
		body: 'There is a presence in the quarters. I will write it plainly since plainness is the rule of this book. It is in the room when the door is shut. It is strongest by night with the fire drawn down. It breathes my air. I keep now to the watch room and sleep in the chair, and sleeping so, wake clearer — it does not climb the stairs.\nLet the next keeper be told. I have signaled for the boat.',
	},
	{
		id: 'fl-1917-01-02', stratum: 'rule-middle', dateLabel: '2 January 1917',
		keeperId: 'conservancy', hand: 'system',
		body: '[No further entries in the preceding hand. Boat log records R. Ash taken off 2 January 1917 at his own signal, term unfinished.]',
	},
	{
		id: 'fl-1919-09-11', stratum: 'rule-middle', dateLabel: '11 September 1919',
		keeperId: 'voss', hand: 'voss', claimRefs: ['V-2'],
		body: 'The watch-room clock runs four minutes slow per day and has for my whole term. I have chalked the correction on the case: light-up by the almanac, then ADD FOUR MINUTES to what this liar of a clock tells you. Checked against three boats’ chronometers this term. Reliable, in its way — it lies by a constant, which is more than can be said of some hands in this book.',
	},
	{
		id: 'fl-1919-10-04', stratum: 'rule-middle', dateLabel: '4 October 1919',
		keeperId: 'voss', hand: 'voss', claimRefs: ['V-3'],
		body: 'Glass 29.61 at seven, 29.58 at nineteen hundred, falling slow, wind SSW 3. For the record as every day of my terms: readings morning and evening, chalked on the case and entered here. An archive of weather is worth a shelf of opinion. Some future hand will thank me or curse the ink I’ve spent; either way they’ll KNOW what the sky was doing.',
	},
	{
		id: 'fl-1912-05-30', stratum: 'rule-early', dateLabel: '30 May 1912',
		keeperId: 'voss', hand: 'voss',
		body: 'Rats have voted against the west grain bin. Motion carried. I have relocated the franchise to sealed tins and written the Conservancy for a cat, without hope. Glass steady, lamp all correct, horn not wanted.',
	},
	{
		id: 'fl-1921-08-01', stratum: 'rule-middle', dateLabel: '1–22 August 1921',
		keeperId: 'sung', hand: 'sung',
		// Rendered as one page in the book: the UI repeats the line per day with
		// the dates running down the margin. The horror is uniformity.
		body: 'All well. H.S.\nAll well. H.S.\nAll well. H.S.\n[…identical entries, one to a night, through the 21st. On the 22nd, in the same hand, same size, same ink:]\nAll well. H.S.',
	},
	{
		id: 'fl-1921-08-19', stratum: 'rule-middle', dateLabel: '19 August 1921',
		keeperId: 'voss', hand: 'voss',
		body: 'I have this term inherited: a landing chain snapped and left snapped, the medical box spent to gauze and a single splint, and three weeks of a log that says ALL WELL in one hand, fifteen letters a night, while the station about it plainly went to ruin.\nTo the keeper before me, whoever taught you letters wasted two of them.\nTo every keeper after me, mark this page: the log is not a courtesy. It is not the Conservancy’s paperwork. It is the only hand any of us can reach back with, and the only one that will ever reach forward for us. Write what happened. Write what you did about it. Write what you could not do, most of all that. The next of us is standing in the dark you leave.\nChain spliced temporary, see workshop bench. Splint list posted inside the medical box lid. — A.V.',
	},

	// ═══ RULE, LATE (1924–1934) — the near stratum ════════════════════════════
	{
		id: 'fl-1926-10-14', stratum: 'rule-late', dateLabel: '14 October 1926',
		keeperId: 'okafor', hand: 'okafor', claimRefs: ['O-1', 'O-2', 'O-3'],
		body: 'To the keeper after me — you’ll want three things before dark, so here they are in order.\nOne: the clock is HONEST now. Repaired by the Conservancy’s man this September, checked by me against two chronometers since. IGNORE the chalk inside the case — I have struck it through but chalk argues back. Light-up by the almanac, straight, no correction.\nTwo: the quarters’ flue. I rodded it from the cap down to the first bend and got a jackdaw’s parish worth of nest out of it. It draws better, not right. The bend below defeated my rod. If you’ve the arm for it, the long rods are behind the workshop door, and the room will thank you. Till then keep the window cracked when the fire’s high, and pay no mind to what an earlier winter keeper wrote of that room. He had my sympathy before I found the nest; now he has my understanding too.\nThree: behind the tea tin there is chocolate. It is not Conservancy issue, it is from me to you. The dark comes at four this time of year and the first week alone is the longest. It gets wider after. Not easier — wider.\nLamp all correct, stores true to my count of this morning, sea quiet.\nYou’ll do well. Most of us have, and the book is how.\n— N. Okafor',
	},
	{
		id: 'fl-1928-07-30', stratum: 'rule-late', dateLabel: '30 July 1928',
		keeperId: 'okafor', hand: 'okafor', claimRefs: ['C-1'],
		// Okafor's last term ends; the count that will have drifted 15% by the
		// player's autumn arrival. Honest when written — staleness is time's work,
		// not his.
		body: 'Boat day, my last of this term and, the Board’s letter says, my last of this station — they want me west for the new gas trials, and a man goes where the light needs keeping.\nStores landed and counted with the boat’s mate as witness: tinned meat forty-one, biscuit two boxes and a started third, oil to the autumn mark, compressor spirit two cans. Count taken at the shelf, not from the manifest.\nWhoever winters here: the station is sound, the book is honest, and the tea tin is not empty. It has been my good fortune to be one hand in this line of hands.\n— N. Okafor',
	},
];

// ═══ THE CELLAR — not part of the log ═══════════════════════════════════════
// Found only if the player draws the nails (S2, optional, the deep one). A
// notebook, salt-stained, the inquiry's stamp on the board. Pure testimony:
// no system consumes it; its only mechanical trace is unlocking the M-1
// margin composition (P-s2-margin1901).
export const CALLUM_JOURNAL = {
	id: 'cellar-callum-journal',
	dateLabel: '19 January 1901',
	keeperId: 'callum', hand: 'callum',
	stamp: 'NOT ENTERED — not the instrument of record.',
	body: 'I must write this while it is hot in me because I can already feel it cooling into the shape the Board will want it in.\nI took the watch at midnight. The lamp was burning. Edwin had wound at his going down — I heard the ratchet through the floor as I climbed, that is a sound a man does not imagine.\nPast two I was taken with a griping in my gut, sudden, doubling me at the desk. I went down to the yard, being ill, I think a quarter hour, I cannot swear it was not longer, a man doubled over a wall in a storm does not keep the log’s kind of time. When I came in the tower the lamp was out. Not guttering. Out. Wound and fueled and out, and I could not get it relit with my hands shaking as they shook, and then Edwin was there in his nightshirt and got it lit as I could not, and through the glass we saw her lights already wrong, already leaning.\nHe will not look at me. He asked me once — once — was it burning when I left the watch room, and I said yes, because it was, I would swear it on the eleven themselves, it WAS burning. And I watched him decide, in the space of that one answer, which of us the record was going to be for.\nThe log is his tonight. He has been up there an hour with it. Whatever it says now, it says in one hand, and mine is in a notebook the Board will never bind.\nEleven men. The bell has not stopped since dawn. If the lamp was burning when I left it, then the fault is in no man and the sea simply took them, and nobody — NOBODY — will write that, because a book wants an author and a wreck wants a keeper’s name under it.',
};

// ═══ THE INDEX — diegetic navigation (QA F9) ════════════════════════════════
// "Index, begun by A. Voss, continued by various hands." An artifact itself:
// imperfect but fair. Brand is unindexed under anything useful — filed under
// "REMARKS, UNCLASSIFIED" by a hand that plainly meant it as a verdict — but
// the fog-siren row points at the era his bell poem sits in, so a player
// working the index honestly can still land near him. The index never marks
// truth; it marks TOPICS. (Failures must trace to judging testimony badly,
// never to the interface hiding the page.)
export const LOG_INDEX = {
	title: 'INDEX, begun by A. Voss, continued by various hands',
	rows: [
		{ topic: 'SIREN — valve, remedy for sticking', entries: ['fl-1905-03-03'], hand: 'voss' },
		{ topic: 'CLOCK — error & correction', entries: ['fl-1919-09-11', 'fl-1926-10-14'], hand: 'voss', laterHand: 'okafor' },
		{ topic: 'OIL — gauge, cold reading, dip-rule', entries: ['fl-1906-08-19'], hand: 'voss' },
		{ topic: 'GLAZING — SW panel, storm damage 1913', entries: ['fl-1913-02-08', 'fl-1913-02-11'], hand: 'quill' },
		{ topic: 'WEATHER — glass readings, archive of', entries: ['fl-1919-10-04'], hand: 'voss' },
		{ topic: 'QUARTERS — winter, complaints of', entries: ['fl-1916-12-05', 'fl-1916-12-28', 'fl-1926-10-14'], hand: 'various' },
		{ topic: 'STORES — counts, boat days', entries: ['fl-1906-08-19', 'fl-1928-07-30'], hand: 'various' },
		{ topic: 'REMARKS, UNCLASSIFIED', entries: ['fl-1908-06-02', 'fl-1908-06-14'], hand: 'unknown' },
		{ topic: 'THE ARRANGEMENT OF 1901', entries: ['fl-1901-03-30'], hand: 'mercer-late' },
	],
};
