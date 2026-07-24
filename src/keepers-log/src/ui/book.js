// book.js — rendering the log: one open page at a time.
//
// View layer only (engine-spec §architecture): reads content data and, later,
// engine state; never mutates either. The book's model of "a page" is a
// STRATUM VIEW — the founding log grouped by its five strata, plus dynamic
// pages (player/NPC entries) appended by later wiring (P4c). Page-turn
// navigation walks that sequence; Voss's index jumps into it.
//
// Why strata-as-pages rather than entry-per-page: the log is an archive the
// player READS ACROSS — cross-referencing is the game — and a page per entry
// would make Q-1-vs-V-3 archaeology a click-mire. A stratum is a "sitting"
// of reading, which is also exactly what the engine's readLog(stratum)
// charges for. Individual entries are addressable within a stratum via
// element ids for index jumps.

import { FOUNDING_LOG, LOG_INDEX, STRATA } from '../content/founding-log.js';
import { AFTERWORD } from '../content/afterword.js';

// Human titles for strata tabs/headers — the book's own era names.
const STRATUM_TITLES = {
	'pair-era': 'The Two-Hands Years · 1894–1901',
	'trouble': 'The Wreck Winter · 1901',
	'rule-early': 'Under the Arrangement · 1901–1913',
	'rule-middle': 'The Middle Years · 1914–1923',
	'rule-late': 'Recent Hands · 1924–1928',
};

/**
 * entryHtml — one entry as book markup.
 * Receives an entry record from founding-log.js (id, dateLabel, hand, body,
 *   margins?, keeperId). Returns an HTML string.
 * The hand class carries the voice (style.css .hand-*); margins render as
 *   indented answers under the body — the log talking to itself. The wreck
 *   page and Conservancy order get their special dress (signal edge, stamp)
 *   by id — content stays free of presentation flags.
 * Exported (QA-2026-07-24 SEC-2/3) so a test pins the id/hand attribute escaping
 *   at the helper — a revert that drops the escapeHtml calls fails against an id
 *   carrying a `"`.
 */
export function entryHtml(entry) {
	const wreck = entry.id === 'fl-1901-01-19' ? ' wreck-page' : '';
	const stamp = entry.id === 'fl-1901-03-30'
		? '<span class="stamp">Conservancy of Lights — By Order</span>' : '';
	const margins = (entry.margins ?? [])
		.map((m) => `<p class="margin">${escapeHtml(m.text)}</p>`)
		.join('');
	// QA-2026-07-24 (SEC-2/3): the id and hand are authored data today, but they
	// land in an `id="…"` and a class name UNESCAPED — the exact "comment says
	// authored-only, the assumption drifts, the bug ships" shape. Escaping them
	// here enforces the authored-only assumption instead of relying on memory of
	// it; the dateline (now an h3 for heading navigation — A11Y-5/6/7) and body
	// were already escaped.
	return `
		<div class="entry hand-${escapeHtml(entry.hand)}${wreck}" id="${escapeHtml(entry.id)}">
			<h3 class="dateline">${escapeHtml(entry.dateLabel)}</h3>
			${stamp}
			<p class="body">${escapeHtml(entry.body)}</p>
			${margins}
		</div>`;
}

/**
 * escapeHtml — content prose into safe markup.
 * Receives a string; returns it with the five HTML-special characters
 *   entity-escaped. The founding log is our own authored data, but player
 *   free text will flow through the SAME renderers later (P4c), and the
 *   personal-note contract says verbatim-preserved — verbatim must never
 *   mean executable. One escape function for all book text, no exceptions.
 * Exported (P4c) so pages.js renders player/NPC entries through the SAME
 *   escape — the ui-spec's "reuse book.js's escape" — rather than growing a
 *   second, driftable copy of the security-critical function.
 */
export function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => (
		{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
	));
}

/**
 * renderStratum — the open page for one era of the book.
 * Receives a stratum key. Returns { html, stratum } for the page shell.
 */
function renderStratum(stratum) {
	const entries = FOUNDING_LOG.filter((e) => e.stratum === stratum);
	const html = `
		<div class="stratum-${stratum}">
			<h2 class="dateline" style="letter-spacing:0.18em">${escapeHtml(STRATUM_TITLES[stratum] ?? stratum)}</h2>
			${entries.map(entryHtml).join('')}
		</div>`;
	return { html, stratum };
}

/**
 * renderIndex — Voss's index as a pull-out leaf.
 * Returns the index page's HTML: topic rows linking into strata pages.
 * Row links carry data-entry ids; book.jumpTo resolves them to a stratum and
 *   scrolls the entry into view — the index navigates, it never marks truth.
 * QA-2026-07-24 (A11Y-1): the row links are <button>s, not href-less <a>s. A
 *   bare <a> with no href is invisible to the keyboard — Tab skips it, Enter
 *   does nothing — so the whole index was mouse-only. The delegated handler on
 *   #page keys on the [data-entry] selector, which a button satisfies exactly as
 *   an anchor did (SEC verified: no sink or escaping change beyond hardening the
 *   id into the attribute). The id is escaped for the same authored-only reason
 *   as entryHtml above.
 */
function renderIndex() {
	const rows = LOG_INDEX.rows.map((r) => `
		<tr>
			<td class="topic">${escapeHtml(r.topic)}</td>
			<td>${r.entries.map((id) => `<button type="button" class="index-link" data-entry="${escapeHtml(id)}">${escapeHtml(entryDate(id))}</button>`).join(' · ')}</td>
		</tr>`).join('');
	return `
		<div class="index-leaf">
			<h2 class="dateline">${escapeHtml(LOG_INDEX.title)}</h2>
			<table><tbody>${rows}</tbody></table>
		</div>`;
}

/** entryDate — an entry id to its human date, for index link labels. */
function entryDate(id) {
	return FOUNDING_LOG.find((e) => e.id === id)?.dateLabel ?? id;
}

/**
 * Book — the page-turn controller.
 * Receives the #page element and the nav buttons; owns which page is open.
 * Pages: cover → each stratum in order → (P4c appends live pages). The
 *   controller is deliberately dumb — an array of render functions and an
 *   index into it; the game layer will splice pages in rather than teach
 *   the book about game state.
 */
export function createBook({ pageEl, prevBtn, nextBtn, indexBtn }) {
	const pages = [
		{ key: 'cover', render: renderCover },
		...STRATA.map((s) => ({ key: s, render: () => renderStratum(s).html, stratum: s })),
		// The afterword sits after the strata, before any live pages a run
		// appends — the author's hand is one more hand in the book, not chrome.
		{ key: 'afterword', render: renderAfterword },
	];
	let current = 0;

	// show — paint page `i`, replay the leaf-settle animation, sync nav state.
	function show(i) {
		current = Math.max(0, Math.min(pages.length - 1, i));
		const page = pages[current];
		pageEl.innerHTML = page.render();
		pageEl.dataset.stratum = page.stratum ?? '';
		pageEl.classList.remove('turning');
		// Reflow so the animation restarts on every turn, not just the first.
		void pageEl.offsetWidth;
		pageEl.classList.add('turning');
		pageEl.scrollTop = 0;
		prevBtn.disabled = current === 0;
		nextBtn.disabled = current === pages.length - 1;
	}

	// appendPage — add a live page (P4c) to the END of the sequence, after the
	// strata, without rebuilding the existing pages. Receives a page spec
	// { key, render } identical in shape to the built-in pages, so the dumb
	// array-of-render-functions model extends cleanly — the book never learns
	// what a "player entry" is; it only holds one more render function.
	// Returns the new page's index so the caller (pages.js) can open it.
	// nextBtn's disabled state is recomputed here because appending changes
	// which page is last; without this the "Later ›" button could stay wrongly
	// disabled when the reader sits on what was the final page. No re-render is
	// forced (appends happen while the desk/interlude overlay covers the book).
	function appendPage(spec) {
		pages.push(spec);
		nextBtn.disabled = current === pages.length - 1;
		return pages.length - 1;
	}

	// jumpTo — index navigation: find the entry's stratum page, open it,
	// scroll the entry into view. The index never says which page is "right";
	// it only takes you where a topic lives.
	function jumpTo(entryId) {
		const entry = FOUNDING_LOG.find((e) => e.id === entryId);
		if (!entry) return;
		const idx = pages.findIndex((p) => p.stratum === entry.stratum);
		if (idx === -1) return;
		show(idx);
		document.getElementById(entryId)?.scrollIntoView({ block: 'start' });
	}

	/**
	 * renderAfterword — the author's page: plain prose, the player's hand class
	 * (it is a page in the same book, not a website "about" modal), reachable
	 * from the cover's quiet link and by paging past the strata.
	 */
	function renderAfterword() {
		// The postscript renders as a SECOND entry under its own h3 dateline —
		// the author's later hand answering his earlier page, the one form this
		// book teaches. Optional in the data so the page degrades gracefully.
		const postscript = AFTERWORD.postscript
			? `<h3 class="dateline">${escapeHtml(AFTERWORD.postscriptTitle)}</h3>
				<div class="entry hand-player"><p class="body">${escapeHtml(AFTERWORD.postscript)}</p></div>`
			: '';
		return `
			<div class="afterword">
				<h2 class="dateline term-title">${escapeHtml(AFTERWORD.title)}</h2>
				<div class="entry hand-player"><p class="body">${escapeHtml(AFTERWORD.body)}</p></div>
				${postscript}
			</div>`;
	}

	function renderCover() {
		// QA-2026-07-24 (A11Y-5/6/7, A11Y-1): the visible cover title is a <p>, not
		// an <h1> — the document's single h1 is the persistent one in #bookwrap, so
		// the cover doesn't mint a second (the .cover .title class fully controls
		// its look, so this is a semantic change only). The afterword link is a
		// <button>, not an href-less <a>, so the keyboard can reach it; the
		// delegated #page handler keys on #to-afterword either way.
		return `
			<div class="cover">
				<p class="title">The Keeper’s Log</p>
				<p class="subtitle">Sorrel Point Light · Conservancy of Lights</p>
				<p class="subtitle" style="margin-top:2.5rem">One keeper to a term.<br>No two keepers ever meet.</p>
				<button class="begin" type="button" id="begin">Open the log</button>
				<p class="cover-afterword"><button type="button" id="to-afterword">why this game exists — an afterword</button></p>
			</div>`;
	}

	prevBtn.addEventListener('click', () => show(current - 1));
	nextBtn.addEventListener('click', () => show(current + 1));
	indexBtn.addEventListener('click', () => { pageEl.innerHTML = renderIndex(); pageEl.dataset.stratum = ''; });
	// Index links + the cover's begin button live inside re-rendered HTML, so
	// one delegated listener on the page element handles both, forever.
	pageEl.addEventListener('click', (ev) => {
		const link = ev.target.closest('[data-entry]');
		if (link) { jumpTo(link.dataset.entry); return; }
		if (ev.target.closest('#to-afterword')) {
			show(pages.findIndex((p) => p.key === 'afterword'));
			return;
		}
		if (ev.target.closest('#begin')) show(1);
	});

	show(0);
	return { show, jumpTo, appendPage };
}
