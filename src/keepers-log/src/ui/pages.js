// pages.js — the book's LIVE pages: the player's own entries and the NPC
// interlude entries, appended after the founding strata so the next keeper
// turns to them exactly as they'd turn to Voss or Okafor.
//
// View layer only (engine-spec §architecture): this renders engine `Entry`
// objects (and the one cellar journal) into the SAME markup the founding log
// uses. It never mutates engine state — game.js owns the state and hands
// finished entries here purely to be drawn.
//
// Why grouped "term" pages rather than a page-per-entry: the founding log is
// read as strata (one sitting per era), and a player term is one such sitting —
// four days of entries belong together under one heading ("Autumn 1928 — your
// term"), the way Pearse's year is one heading. So a term is a SECTION whose
// entry list grows as the days are written, and the book holds ONE page object
// per section. Appending a fourth day's entry re-renders that section in place;
// it never creates a new book page or rebuilds the earlier ones (the ui-spec's
// "accept appended pages without rebuilding existing ones").

import { escapeHtml } from './book.js';

/**
 * renderEngineEntry — one engine Entry as book markup.
 * Receives an engine Entry ({ id, dateLabel, sentences:[{text}], signature,
 *   personalNote? }) and the hand key that carries its typographic voice
 *   (design-spec §8 — 'player' for the player's own hand, 'pearse'/'reed' for
 *   the NPC keepers). Returns an HTML string.
 * Operational sentences are joined with a blank line (the .body class is
 *   white-space:pre-line, so "\n\n" renders as a paragraph gap) because each
 *   composed sentence is a distinct remark, not a continuous paragraph.
 * The signature line is drawn ONLY for the player's hand: the player chose that
 *   mark (design-spec §5, "the player chooses each keeper's signature"), so it
 *   is content worth showing. The NPC templates already sign themselves inline
 *   ("— D.P."), so a second signature line would double the sign-off — hence the
 *   hand === 'player' gate rather than always rendering entry.signature.
 * All text passes through book.js's escapeHtml: player free text and NPC prose
 *   alike are DATA, never markup (the personal-note verbatim contract must never
 *   become "verbatim-executable").
 */
export function renderEngineEntry(entry, hand) {
	const body = entry.sentences.map((s) => escapeHtml(s.text)).join('\n\n');
	const note = (typeof entry.personalNote === 'string' && entry.personalNote.length > 0)
		? `<p class="body personal-note">${escapeHtml(entry.personalNote)}</p>`
		: '';
	const signature = (hand === 'player' && entry.signature)
		? `<p class="signature">— ${escapeHtml(entry.signature)}</p>`
		: '';
	// The dateline is an h3 (QA-2026-07-24 A11Y-5/6/7): each entry is a subsection
	// under its term's h2 heading, so screen readers and the keyboard can jump
	// entry-to-entry. The visual is preserved by CSS (see the heading neutralizer
	// under the QA banner in style.css).
	return `
		<div class="entry hand-${escapeHtml(hand)}" id="live-${escapeHtml(entry.id)}">
			<h3 class="dateline">${escapeHtml(entry.dateLabel)}</h3>
			<p class="body">${body}</p>
			${note}
			${signature}
		</div>`;
}

/**
 * renderComposedPreview — the desk's live "what your page will look like".
 * Receives a preview-shaped entry ({ dateLabel, sentences:[{text}], signature,
 *   personalNote? }); returns the SAME markup a signed player page uses, so the
 *   desk shows the actual book page before signing (design-spec §4: "renders as
 *   the actual book page BEFORE signing"). It is always the player's hand.
 * A distinct id keeps the preview from colliding with any real appended entry.
 */
export function renderComposedPreview(previewEntry) {
	return renderEngineEntry({ ...previewEntry, id: 'desk-preview' }, 'player');
}

/**
 * renderJournal — the Callum cellar notebook as a book page.
 * Receives the CALLUM_JOURNAL content record ({ id, dateLabel, keeperId, hand,
 *   stamp, body }); returns HTML. It is founding-shaped (a `body`, not composed
 *   sentences) and carries a stamp, so it renders like a founding entry with the
 *   same .stamp treatment the Conservancy order uses — reusing the existing CSS,
 *   not a new one. Pure content; drawn only after the player draws the nails.
 */
export function renderJournal(journal) {
	const stamp = journal.stamp ? `<span class="stamp">${escapeHtml(journal.stamp)}</span>` : '';
	return `
		<div class="live-pages">
			<h2 class="dateline term-title">From the cellar — a notebook never entered</h2>
			<div class="entry hand-${escapeHtml(journal.hand)}" id="live-${escapeHtml(journal.id)}">
				<h3 class="dateline">${escapeHtml(journal.dateLabel)}</h3>
				${stamp}
				<p class="body">${escapeHtml(journal.body)}</p>
			</div>
		</div>`;
}

/**
 * renderSection — one term's page: a heading plus its accumulated entries.
 * Receives a section ({ title, entries:[{entry, hand}] }); returns HTML. The
 *   render reads the section's LIVE entries array, so appending a day's entry
 *   and re-showing the page reflects it without the book re-creating the page.
 */
function renderSection(section) {
	const title = section.title
		? `<h2 class="dateline term-title">${escapeHtml(section.title)}</h2>`
		: '';
	const body = section.entries.map((e) => renderEngineEntry(e.entry, e.hand)).join('');
	return `<div class="live-pages">${title}${body}</div>`;
}

/**
 * createPages — the live-page controller.
 * Receives { book } — the book controller from createBook (needs appendPage).
 * Returns { addEntry, addJournalPage }.
 * Holds a map of term SECTIONS keyed by a caller-supplied pageKey. game.js owns
 *   the term vocabulary (which shift is which term), so it passes the pageKey /
 *   title / hand as `meta`; pages.js stays free of content knowledge — a clean
 *   view/content seam that also makes resume trivial (replay addEntry over the
 *   saved entries in order and the book rebuilds identically).
 */
export function createPages({ book }) {
	// pageKey -> { title, entries:[{entry, hand}], render, index }. Bounded by
	// the finite number of terms (≤3 player + 2 NPC), so no growth cap needed.
	const sections = new Map();

	/**
	 * ensureSection — find or create the section for a pageKey.
	 * Receives a pageKey and its title; returns the section. On first sight it
	 *   creates the section AND appends its page to the book once — later entries
	 *   for the same term reuse it, so the book gains one page per term, not one
	 *   per entry.
	 */
	function ensureSection(pageKey, title) {
		const existing = sections.get(pageKey);
		if (existing) return existing;
		const section = { title, entries: [] };
		section.render = () => renderSection(section);
		section.index = book.appendPage({ key: pageKey, render: section.render });
		sections.set(pageKey, section);
		return section;
	}

	/**
	 * addEntry — append one finished entry to its term page.
	 * Receives an engine Entry and meta { pageKey, title, hand }. Returns the
	 *   book page index of that term (so the caller can open it). The entry is
	 *   stored (not mutated) alongside its hand; renderSection reads it live.
	 */
	function addEntry(entry, meta) {
		const section = ensureSection(meta.pageKey, meta.title);
		section.entries.push({ entry, hand: meta.hand });
		return section.index;
	}

	/**
	 * addJournalPage — append the cellar journal as its own book page.
	 * Receives the journal content record; returns its page index. Idempotent by
	 *   key so a resume-rebuild (or a double open) cannot duplicate it.
	 */
	function addJournalPage(journal) {
		const key = `journal-${journal.id}`;
		const existing = sections.get(key);
		if (existing) return existing.index;
		const section = { title: null, entries: [] };
		section.render = () => renderJournal(journal);
		section.index = book.appendPage({ key, render: section.render });
		sections.set(key, section);
		return section.index;
	}

	return { addEntry, addJournalPage };
}
