// finale.js — the last desk, the book's fate, and the transfer record.
//
// P4e content, authored with the whole game behind it. Design contract
// (design-spec v1.2 §5, consensus F1/F7): shift 3 day 2 is the last night;
// the final entry is written in the knowledge that NO successor will read
// it; the epilogue is a diegetic Conservancy transfer record limited to a
// few decisive chains — never a moral ledger; the book's fate shows its
// consequence, never narrates it as loss; then one line for the oldest
// prior-playthrough page if one exists, and the wordless close.
//
// The final composition options are the game's registers handed back to the
// player: Voss's summa, Okafor's letter, Mercer's bare record, Brand's one
// line, or silence. No tags route anywhere — nothing downstream consumes
// this entry. It is the one page in the game written for no reader, which
// is to say: the one the player writes for themselves.

export const FITTER_LINES = [
	'The fitter lands with the morning boat and three crates. He is civil and quick and talks only when the work wants it: which bolts, whose ladder, where the acetylene cylinders will stand.',
	'"She’ll flash the same character," he says, tapping the crate. "Mariners won’t know the difference." He says it as a kindness, and means it as one.',
	'By afternoon the new beacon sits on the gallery like a patient visitor. The fitter leaves with the tide. "Last of the month, then," he says from the boat. It is not clear what he is wishing you.',
];

// The last-desk statement set. Each option is a complete final entry —
// register handed back to the player. statementIds are stable for the
// epilogue's reference; no claimIds, no tags, no consequences.
export const FINAL_ENTRY_OPTIONS = [
	{
		statementId: 'final-summa', registerLabel: 'The full account',
		text: 'To no keeper. The station stands as follows, and I will set it down properly though the Conservancy has asked only for the keys. Light: extinguished this night by order, the mechanism sound, the lens clean, fuel to the spring mark. Siren: serviceable; the valve wants the mallet in cold weather, as this book has said since 1905. Stores: counted at the shelf this morning, true to the page. The tower is dry, the cottage flue draws honest, the landing chain will want renewing for whoever maintains the beacon, and I have written that on a card and nailed it in the boathouse, since cards are all the reading this station will get now.\nThe book closes in good order. That was always the whole of the duty, and it is done.',
	},
	{
		statementId: 'final-letter', registerLabel: 'The letter',
		text: 'To whoever finds this book — and someone will; books like this are always found, long after, by someone with cold hands in an empty room.\nEvery page before this one was written for the next keeper. There is no next keeper, so this page is for you, whoever you are, at whatever distance. Three things, in order, the way a good hand once taught this book to say them.\nOne: the light never failed for want of being loved. When it failed, and it did, it failed the way all kept things fail — for an hour, in weather, with someone climbing the stairs toward it in the dark.\nTwo: the hands in this book were strangers to each other, every one. Read the margins and see what strangers can be.\nThree: there was chocolate behind the tea tin once. I have left what I had in the same place. The dark comes at four in winter here. You will want it.',
	},
	{
		statementId: 'final-record', registerLabel: 'The bare record',
		text: 'Light extinguished this night by order of the Conservancy, the station discontinued, the automated beacon in service from tomorrow sunset. Weights run down. Fuel valve closed. All watches stood.\nNothing further.',
	},
	{
		statementId: 'final-line', registerLabel: 'The borrowed line',
		text: 'Let the record show the darkness was contested.',
		// Brand's sentence, 1908, handed to the player for the last page. The
		// epilogue notes the borrowing only if the player read Brand's stratum
		// this playthrough — a private rhyme, never explained otherwise.
	},
	{
		statementId: 'final-unsigned', registerLabel: 'Close the book unsigned',
		text: '',
		// Silence, chosen. The epilogue renders the empty last page as itself:
		// the one omission the game never punishes — there is no one left to
		// be ambushed by it.
	},
];

// The book's fate. Consequence lines appear ONLY in the epilogue, in the
// register each fate deserves; the choice buttons carry only the plain act.
export const BOOK_FATES = [
	{
		id: 'fate-archive', label: 'Surrender the log to the Conservancy',
		epilogue: 'RECEIPT. One station log, Sorrel Point, surrendered complete, boards water-stained, spine sound. Filed under DISCONTINUED STATIONS, shelf 40, with the logs of the Nab, the Calf, and the Wick. Retrieval requires written application, which the file notes has, to date, not occurred.',
	},
	{
		id: 'fate-tower', label: 'Leave the log on the watch-room desk',
		epilogue: 'The book stays where the book has always been, squared to the desk edge, the pen beside it. The door is locked on an empty tower. Whatever weather does to an unkept room, it does slowly, and to everything alike.',
	},
	{
		id: 'fate-taken', label: 'Take the log with you on the boat',
		epilogue: 'It goes down the tower stairs under a coat, which is against the Order, and onto the boat, which is against the Order, and nobody checks, because the Order was written for a station that no longer exists. Somewhere inland, for some years yet, there is a shelf where the sea does not reach, and a book on it that smells faintly of oil and salt when the evenings are damp.',
	},
];

// ── The transfer record (the epilogue's spine) ─────────────────────────────
// A Conservancy form, rendered in the mono/stamp register. It shows AT MOST
// four items: the decisive chains, selected by priority from the run's
// consequence log. Each authored line receives the player's quoted sentence
// where the chain turned on one ({{quote}} splice, same token contract as
// interludes — the epilogue renderer reuses the engine's splice).
//
// Priority is authored, not computed: the first four ids present in the
// consequence log win. Honesty beats drama in the ordering — the record
// shows what MATTERED, and what mattered most is what other hands built on.
export const TRANSFER_RECORD = {
	header: 'CONSERVANCY OF LIGHTS — TRANSFER OF STATION RECORD\nSorrel Point Light · Discontinued by Order · The log examined and annexed',
	footer: 'The Board notes that the instrument of record was maintained to the last hour of the last keeping. No further entries will be made.',
	items: [
		// The gutter chain — every branch is a candidate; at most one fires.
		{ nodeId: 'pearse-gutter-honest-closed', line: 'Item. Query of the Board (coaster Ilsa, autumn 1928) CLOSED by the keeper’s own page, which the Board’s minute quotes: “{{quote}}”. The Board records that a plain entry spared a hearing.' },
		{ nodeId: 'pearse-gutter-lie-shutters', line: 'Item. Storm shutters fitted 1930 at the Board’s cost, per requisition citing the log: “{{quote}}”. The Board’s surveyor notes, without further remark, that no gale answering the page’s description appears in the district returns for that autumn.' },
		{ nodeId: 'pearse-gutter-omitted-ambush', line: 'Item. Query of the Board (coaster Ilsa, autumn 1928) closed UNRESOLVED, the log silent on the night in question. The file carries the examining keeper’s annotation: the record shows nothing.' },
		{ nodeId: 'pearse-gutter-vague-correspondence', line: 'Item. Correspondence concerning the coaster Ilsa (autumn 1928), four letters, closed without finding. The log’s relevant page is quoted in the file: “{{quote}}”.' },
		// The bell chain.
		{ nodeId: 'reed-bell-notice-near-miss-averted', line: 'Item. NOTICE TO MARINERS No. 214: the Sisters bell re-charted as dragging in heavy weather. Origin of intelligence: this log, two hands, twenty-two years apart, the later quoted: “{{quote}}”.' },
		{ nodeId: 'reed-bell-silence-grounding', line: 'Item. Inquiry into the grounding of the coaster Merrow (1932) annexed to this file. The log was produced and examined. The examining officer’s note is retained: the warning existed in the book since 1908, in a form the book itself had taught its readers to pass over.' },
		{ nodeId: 'reed-bell-vague-near-thing', line: 'Item. Report on the Sisters bell forwarded 1932 over the keeper S. Reed’s signature, crediting an earlier hand’s ear: “{{quote}}”.' },
		// The flue chain.
		{ nodeId: 'reed-flue-finished-silence', line: 'Item. The quarters certified sound for winter keeping from 1930, the chimney cleared by the keeper of that term: “{{quote}}”. The Board notes fourteen years of complaints of that room, and their end.' },
		{ nodeId: 'reed-flue-lie-inherited-ash', line: 'Item. The keeper S. Reed’s complaint (1931) concerning the quarters chimney, annexed with his annotation that the log’s page on the matter — “{{quote}}” — is contradicted by the chimney itself. The Board takes no position between a page and a flue.' },
		// The stores chain (quieter; fills the fourth slot when it ran).
		{ nodeId: 'pearse-stores-book-healed', line: 'Item. Stores reconciled to the shelf from autumn 1928, the correcting count quoted at each subsequent audit: “{{quote}}”.' },
		{ nodeId: 'pearse-stores-guess-ration', line: 'Item. The keeper D. Pearse’s ration fortnight (February 1929) noted; the Board’s auditor traces the shortfall through three terms of counts initialed forward, and marks the practice, not the keepers, at fault.' },
		// The margin — if it exists, it always claims a slot (authored order
		// puts it last so it reads as the record's quietest item).
		{ nodeId: 'reed-margin-found', line: 'Item. An annotation in a private hand upon the page for 19 January 1901, contrary to regulation, retained unexpunged by direction of the examining officer, whose minute reads in full: let it stand.' },
	],
};

// The persistence line (design-spec §7): shown ONLY when a prior
// playthrough's entries exist in the archive. {{date}} is the real-world
// date of the oldest archived entry. One sentence, no elaboration.
export const ARCHIVE_LINE =
	'This page was written by a keeper of this station on {{date}}. The log you leave is the log you’ll be given.';

// The last thing the game says, after the beam's final sweep, before the
// book closes. Two sentences, then done — the closing image itself is
// wordless (scene: one sweep, lamp out, book shuts).
export const CLOSING_LINE =
	'The light is the beacon’s now, and needs no witness. What the keepers kept is in your hands.';
