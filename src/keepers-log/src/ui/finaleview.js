// finaleview.js — the last shift: the fitter's notice, the last desk, the
// book's fate, and the epilogue transfer record.
//
// View layer. This renders the P4e content (src/content/finale.js) into the
// desk overlay and hands the player's choices back to game.js, which owns the
// state and does the one composeEntry the finale needs. The epilogue is the one
// place the UI touches the cross-playthrough archive: it archives THIS run's
// whole record, then reads the archive back to decide whether a prior run
// exists (the persistence-is-the-thesis line).
//
// The transfer record reuses the engine's quote-token contract (QUOTE_TOKEN):
// each decisive chain's authored line carries {{quote}} where the player's own
// sentence belongs, and we splice with a FUNCTION replacement (never a string
// one) so the player's text can never trigger $-pattern rewriting — the same
// safety the interlude's spliceQuote uses, which is not exported to import.

import { escapeHtml } from './book.js';
import { QUOTE_TOKEN } from '../engine/interlude.js';
import { archiveEntries, loadArchive } from '../engine/persist.js';
import { MAX_PERSONAL_NOTE_CHARS } from '../engine/desk.js';
import {
	FITTER_LINES, FINAL_ENTRY_OPTIONS, BOOK_FATES,
	TRANSFER_RECORD, ARCHIVE_LINE, CLOSING_LINE,
} from '../content/finale.js';

const MAX_SIGNATURE_CHARS = 24;
// Header line the last desk carries beneath the date (finale-spec, verbatim).
const LAST_DESK_LINE = 'No keeper follows you. The page is yours.';

// nodeId prefix → the player claim whose signed sentence that chain quotes
// (finale-spec QUOTE_SOURCES). Longest-prefix-safe because each prefix is a
// distinct hook family; matched by startsWith.
const QUOTE_SOURCES = [
	{ prefix: 'pearse-gutter', claimId: 'P-s1-gutter' },
	{ prefix: 'pearse-gauge', claimId: 'P-s1-gauge' },
	{ prefix: 'pearse-slates', claimId: 'P-s1-slates' },
	{ prefix: 'pearse-stores', claimId: 'P-s1-stores' },
	{ prefix: 'reed-bell', claimId: 'P-s2-bell' },
	{ prefix: 'reed-flue', claimId: 'P-s2-flue' },
	{ prefix: 'reed-margin', claimId: 'P-s2-margin1901' },
];

/**
 * spliceQuote — insert a player sentence into an authored line at QUOTE_TOKEN.
 * Receives the template line and the quote; returns the line with every token
 *   replaced by the quote, LITERALLY (function replacement — a `$&` in the
 *   player's text can never expand). Mirrors interlude.js's private splice.
 */
export function spliceQuote(line, quote) {
	return line.replaceAll(QUOTE_TOKEN, () => quote);
}

/** spliceDate — fill ARCHIVE_LINE's {{date}} token literally (function repl).
 * Same $-safety as spliceQuote: the date is authored-shaped (YYYY-MM-DD) today,
 *   but the function replacement means even a `$&`-bearing value could never
 *   expand — one of SEC's two splice invariants, pinned by the QA UI tests.
 * Exported (QA-2026-07-24 TA-1 batch) so BOTH replaceAll copies are pinned. */
export function spliceDate(line, date) {
	return line.replaceAll('{{date}}', () => date);
}

/**
 * claimForNode — the player claim a consequence node quotes, or null.
 * Receives a nodeId; returns the QUOTE_SOURCES claimId whose prefix it starts
 *   with (the gutter node 'pearse-gutter-honest-closed' → 'P-s1-gutter'), else
 *   null for nodes that quote nothing (the ambush/silence lines).
 */
export function claimForNode(nodeId) {
	const source = QUOTE_SOURCES.find((s) => nodeId.startsWith(s.prefix));
	return source ? source.claimId : null;
}

/**
 * lastPlayerQuote — the player's binding sentence for a claim.
 * Receives the state and a claimId; returns the text of the LAST sentence with
 *   that claimId among the player's own entries (keeperId starting "keeper-"),
 *   or '' if none. Mirrors the engine's last-match rule (interlude
 *   findPlayerSentence): a keeper's final word on a claim is the binding one, so
 *   the epilogue quotes the same sentence the interlude routed on.
 * Bounded by the entry/sentence counts (both engine-capped).
 */
export function lastPlayerQuote(state, claimId) {
	let quote = '';
	for (const entry of state.entries) {
		if (!entry.keeperId.startsWith('keeper-')) continue;
		for (const sentence of entry.sentences) {
			if (sentence.claimId === claimId) quote = sentence.text;
		}
	}
	return quote;
}

// The margin annotation is authored LAST in TRANSFER_RECORD.items and, once it
// has fired, always claims a slot (AUTHOR RULING, QA TA-2): the record's
// quietest item must survive the richest playthroughs. Before this, a maximal
// run whose first four chains all fired pushed the margin off the end — the code
// contradicted finale.js's "if it exists, it always claims a slot" comment. Now
// the cap governs the CHAINS around the margin, not the margin itself.
const MARGIN_NODE_ID = 'reed-margin-found';

/**
 * itemLine — one transfer-record item as its finished, splice-resolved string.
 * Receives an item ({ nodeId, line }) and the state; returns the authored line
 *   with its {{quote}} (if present) replaced by the player's binding sentence for
 *   that chain, or the line unchanged when it carries no token. Splitting this
 *   out lets the chain loop and the reserved margin share one splice path.
 */
function itemLine(item, state) {
	if (!item.line.includes(QUOTE_TOKEN)) return item.line;
	const claimId = claimForNode(item.nodeId);
	return spliceQuote(item.line, claimId ? lastPlayerQuote(state, claimId) : '');
}

/**
 * transferItemLines — the up-to-four decisive chains for the record.
 * Receives the state; returns an array of finished HTML-ready strings (author's
 *   lines with any {{quote}} spliced). Walks TRANSFER_RECORD.items IN AUTHORED
 *   ORDER (priority is authored, not computed), includes an item only when its
 *   nodeId fired this run (∈ consequenceLog).
 * The margin (QA TA-2) is RESERVED: when it fired it is always appended last, and
 *   the chain cap drops to three to leave its slot — so the total is still ≤ 4,
 *   but the margin can never be crowded out by four louder chains. When the
 *   margin did not fire, four chains fill the record as before.
 * Exported (QA-2026-07-24 TA-1 batch) so the all-five-chains-fired fixture pins
 *   the one cell where the cap and the "always claims a slot" promise collide.
 */
export function transferItemLines(state) {
	const marginFired = state.consequenceLog.includes(MARGIN_NODE_ID);
	const chainCap = marginFired ? 3 : 4; // reserve the fourth slot for the margin
	const lines = [];
	for (const item of TRANSFER_RECORD.items) {
		if (item.nodeId === MARGIN_NODE_ID) continue; // reserved; appended below
		if (lines.length >= chainCap) break;
		if (!state.consequenceLog.includes(item.nodeId)) continue;
		lines.push(itemLine(item, state));
	}
	if (marginFired) {
		lines.push(itemLine(TRANSFER_RECORD.items.find((i) => i.nodeId === MARGIN_NODE_ID), state));
	}
	return lines;
}

/**
 * oldestPriorRunDate — the date of the oldest archived run that is NOT this one.
 * Receives the archive result and this run's id; returns 'YYYY-MM-DD' or null.
 *   runIds are oldest-first (archiveEntries appends), so the first id that isn't
 *   this run is the oldest prior. null when this is the only run (the archive
 *   line is shown ONLY on a second-or-later playthrough).
 */
export function oldestPriorRunDate(archive, runId) {
	if (!archive.ok) return null;
	const prior = archive.runIds.filter((id) => id !== runId);
	if (prior.length === 0) return null;
	return prior[0].replace(/^run-/, '').slice(0, 10);
}

/**
 * createFinale — the finale controller.
 * Receives { mountEl, scene, storage }: the desk overlay element, the scene api
 *   (for the closing lamp-out), and the storage adapter (for the archive).
 * Returns { fitterNotice, lastDesk, bookFate, epilogue } — game.js calls these
 *   in order across shift 3, owning the state and the composeEntry between them.
 */
export function createFinale({ mountEl, scene, storage }) {

	/**
	 * fitterNotice — shift-3 day-1 opener: the three fitter paragraphs, one
	 * "Return to the day" button. Receives onReturn (game hides the overlay and
	 * re-enables the day).
	 */
	function fitterNotice(onReturn) {
		// Reveal + inert + focus are game.js's openOverlay job now (QA-2026-07-24
		// CR-1); this controller only renders. (Same for lastDesk/bookFate/epilogue.)
		const paras = FITTER_LINES.map((l) => `<p class="interstitial-line">${escapeHtml(l)}</p>`).join('');
		mountEl.innerHTML = `
			<div class="desk-inner interstitial fitter">
				${paras}
				<div class="interstitial-actions">
					<button id="fitter-return" type="button">Return to the day</button>
				</div>
			</div>`;
		mountEl.querySelector('#fitter-return').addEventListener('click', onReturn);
	}

	/**
	 * lastDesk — the final entry. Receives { dateLabel, signature, onSign }.
	 *   Renders FINAL_ENTRY_OPTIONS as full-text radios (registerLabel the small
	 *   eyebrow), the personal note, the prefilled-but-editable signature, and a
	 *   "Close the log" button DISABLED until a choice is made — so silence
	 *   ('final-unsigned') must be chosen, never defaulted into.
	 *   onSign receives the chosen draft { statementId, text, personalNote?,
	 *   signature } OR null for 'final-unsigned' (no entry is composed).
	 */
	function lastDesk({ dateLabel, signature, onSign }) {
		const session = { selected: null, note: '', signature: signature ?? '' };

		function paint() {
			const options = FINAL_ENTRY_OPTIONS.map((o) => {
				const body = o.text
					? escapeHtml(o.text)
					: '<em>The last page is left blank.</em>';
				const checked = session.selected === o.statementId ? ' checked' : '';
				return `
					<label class="desk-option final-option">
						<input type="radio" name="final" value="${o.statementId}"${checked}>
						<span class="final-option-body">
							<span class="final-register">${escapeHtml(o.registerLabel)}</span>
							<span class="desk-option-text">${body}</span>
						</span>
					</label>`;
			}).join('');
			mountEl.innerHTML = `
				<div class="desk-inner last-desk">
					<header class="desk-header">
						<p class="desk-dateline">${escapeHtml(dateLabel)}</p>
						<p class="desk-event">${escapeHtml(LAST_DESK_LINE)}</p>
					</header>
					<fieldset class="last-desk-options">
						<legend class="vh">The last entry — choose one register, or close the book unsigned</legend>
						${options}
					</fieldset>
					<label class="desk-note-label" for="desk-note">A line of your own, if you want one. The next keeper reads it as you wrote it.</label>
					<textarea id="desk-note" maxlength="${MAX_PERSONAL_NOTE_CHARS}" rows="4">${escapeHtml(session.note)}</textarea>
					<label class="desk-sign-as">Sign as:
						<input id="desk-sig" type="text" maxlength="${MAX_SIGNATURE_CHARS}" value="${escapeHtml(session.signature)}">
					</label>
					<button id="finale-sign" type="button" class="desk-sign"${session.selected ? '' : ' disabled'}>Close the log</button>
				</div>`;
		}

		mountEl.onchange = (ev) => {
			if (ev.target.name === 'final') {
				session.selected = ev.target.value;
				// Only the button's disabled state changes; repaint to reflect it.
				const btn = mountEl.querySelector('#finale-sign');
				if (btn) btn.disabled = false;
			}
		};
		mountEl.oninput = (ev) => {
			if (ev.target.id === 'desk-note') session.note = ev.target.value;
			else if (ev.target.id === 'desk-sig') session.signature = ev.target.value;
		};
		mountEl.onclick = (ev) => {
			if (ev.target.id !== 'finale-sign' || !session.selected) return;
			mountEl.onchange = mountEl.oninput = mountEl.onclick = null; // one-shot
			const option = FINAL_ENTRY_OPTIONS.find((o) => o.statementId === session.selected);
			if (option.statementId === 'final-unsigned') { onSign(null); return; }
			const draft = { statementId: option.statementId, text: option.text, signature: session.signature };
			if (session.note.length > 0) draft.personalNote = session.note;
			onSign(draft);
		};
		paint();
	}

	/**
	 * bookFate — the three fates, label only (the consequence lines are the
	 * epilogue's, never shown here). Receives onChoose(fate) with the chosen
	 * BOOK_FATES entry.
	 */
	function bookFate(onChoose) {
		const buttons = BOOK_FATES
			.map((f) => `<button type="button" data-fate="${escapeHtml(f.id)}">${escapeHtml(f.label)}</button>`)
			.join('');
		mountEl.innerHTML = `
			<div class="desk-inner interstitial book-fate">
				<p class="interstitial-line">The boat waits at the slipway. What becomes of the book?</p>
				<div class="interstitial-actions fate-actions">${buttons}</div>
			</div>`;
		// One-shot (QA-2026-07-24 AT-4): a double-click must not choose two fates and
		// run the epilogue twice. The latch is local to this render, so the guard
		// dies with the DOM it guards.
		let chosen = false;
		mountEl.querySelectorAll('[data-fate]').forEach((b) => {
			b.addEventListener('click', () => {
				if (chosen) return;
				chosen = true;
				onChoose(BOOK_FATES.find((f) => f.id === b.dataset.fate));
			});
		});
	}

	/**
	 * epilogue — the transfer record, the (conditional) archive line, the closing
	 * line, and the close button. Receives { state, fate, onClose }.
	 * Archives THIS run's whole record FIRST (runId at full ISO precision so
	 *   same-day replays never collide), then reads the archive back to learn
	 *   whether a prior run exists. On "Close the book": the lamp goes out for
	 *   good, a 1.2s beat passes (skipped under prefers-reduced-motion), then
	 *   onClose() returns the game to the cover.
	 */
	function epilogue({ state, fate, onClose, runId }) {
		// runId is minted ONCE in game.js startFresh and persisted (QA-2026-07-24
		// AT-2), NOT read from `new Date()` here as before. The Date-in-render was
		// the exact nondeterminism the engine banned, and it defeated
		// archiveEntries' per-runId idempotency: a refresh mid-epilogue then a
		// resume re-entered with a FRESH id and double-archived the run. With the
		// stable id, the second archive skips (same run) while distinct runs still
		// archive separately.
		// The engine refuses (never clobbers) on an unreadable/newer archive or
		// quota; the run still ends gracefully — the refusal is worth a console
		// trace so a player who never sees the archive line on replay has a
		// diagnosable reason (Power-of-Ten rule 7: no return value ignored silently).
		const archived = archiveEntries(storage, state.entries, runId);
		if (!archived.ok) console.warn('keepers-log: archive failed —', archived.error);
		const archiveDate = oldestPriorRunDate(loadArchive(storage), runId);

		const itemsHtml = transferItemLines(state)
			.map((line) => `<p class="tr-item">${escapeHtml(line)}</p>`)
			.join('');
		const archiveHtml = archiveDate
			? `<p class="epilogue-archive">${escapeHtml(spliceDate(ARCHIVE_LINE, archiveDate))}</p>`
			: '';
		mountEl.innerHTML = `
			<div class="desk-inner epilogue">
				<div class="transfer-record hand-conservancy">
					<p class="tr-header">${escapeHtml(TRANSFER_RECORD.header)}</p>
					${itemsHtml}
					<p class="tr-item tr-fate">${escapeHtml(fate.epilogue)}</p>
					<p class="tr-footer">${escapeHtml(TRANSFER_RECORD.footer)}</p>
				</div>
				${archiveHtml}
				<p class="epilogue-closing">${escapeHtml(CLOSING_LINE)}</p>
				<div class="interstitial-actions">
					<button id="finale-close" type="button">Close the book</button>
				</div>
			</div>`;
		// One-shot close (QA-2026-07-24 AT-4): a second click during the 1.2s beat
		// must not schedule a second onClose — that would be a double startNewRun /
		// double reload. The latch is local to this render, so it dies with the DOM.
		let closing = false;
		mountEl.querySelector('#finale-close').addEventListener('click', () => {
			if (closing) return;
			closing = true;
			scene.setLamp(false); // the warmth goes out for good
			const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			if (reduce) onClose();
			else setTimeout(onClose, 1200);
		});
	}

	return { fitterNotice, lastDesk, bookFate, epilogue };
}
