// deskview.js — the writing desk: the game's emotional center.
//
// View layer. The desk overlays the book panel (the book BECOMES the desk) and
// presents the two equally-visible layers of design-spec §4:
//   1. the OPERATIONAL entry — one choice per writable subject, each choice the
//      frozen sentence the keeper would actually sign (the player picks
//      sentences, not abstractions), gated by what this keeper OBSERVED; and
//   2. the PERSONAL note — free text to whoever comes next.
// A live preview renders the composed page as it will appear in the book,
// before signing, so the sentence you're about to sign is the sentence you see.
//
// The desk builds a DRAFT and hands it to game.js (onSign); game.js calls the
// engine's composeEntry. composeEntry THROWS on an illegal composition (a
// precise line about an unobserved fact, an untagged claim) — the ui-spec is
// explicit that the UI must PREVENT that, never catch it. Prevention here:
// precise options are DISABLED unless observed, and every option carries a
// certainty, so no draft this desk can build is illegal.

import { statementOptions, MAX_PERSONAL_NOTE_CHARS } from '../engine/desk.js';
import { CLAIMS } from '../content/claims.js';
import { TEMPLATES } from '../content/desk-statements.js';
import { renderComposedPreview } from './pages.js';
import { escapeHtml } from './book.js';

// The signature field cap (ui-spec: "any mark, maxlength 24").
const MAX_SIGNATURE_CHARS = 24;
// The storm-night claim: its subject group is only writable when the lamp
// actually guttered (design-spec / ui-spec: a gutter that never happened has no
// honest report, so the whole subject is withheld when the lamp held).
const GUTTER_CLAIM = 'P-s1-gutter';

/**
 * templateText — the frozen text for one option.
 * Receives an option spec ({ statementId, certainty }); returns the verbatim
 *   TEMPLATES string keyed `${statementId}|${certainty}`. This is the SAME
 *   lookup composeEntry uses, so the preview and the signed entry are identical
 *   by construction.
 */
function templateText(option) {
	return TEMPLATES[`${option.statementId}|${option.certainty}`] ?? '';
}

/**
 * optionSubject — the fact one option speaks about.
 * Receives an option spec; returns the Subject from its claim in the registry.
 *   The observation gate keys on this subject (a precise line can only be
 *   written about an observed fact).
 */
function optionSubject(option) {
	return CLAIMS[option.claimId]?.subject;
}

/**
 * subjectVisible — should this writable subject appear at the desk right now?
 * Receives a subject group (from S1/S2_STATEMENTS) and the state. Returns bool.
 * Two gates, both from the ui-spec:
 *   - requiresFlag: e.g. the 1901 margin only after the cellar is opened.
 *   - the gutter filter: the storm-night group appears only when the lamp truly
 *     guttered — when it held (the player pumped), there is nothing to confess,
 *     shade, or lie about, so the group is withheld entirely.
 * Exported (QA-2026-07-24 TA-1 batch) so a test pins this UI copy of the storm/
 *   flag gates directly: it is a copy of engine-adjacent rules, and a silent
 *   revert here would pass every existing test — the visibility of the gutter
 *   subject is the SOLE UI guard, backstopped by the engine's compose gate.
 */
export function subjectVisible(group, state) {
	if (group.requiresFlag && !state.flags[group.requiresFlag]) return false;
	const isGutter = group.options.some((o) => o.claimId === GUTTER_CLAIM);
	if (isGutter && state.systems?.light?.stormNightLapse !== 'guttered') return false;
	// The roof is writable only once there is something to write: before the
	// storm, even the vague "took some hurt in the storm" line would be fiction
	// about weather that hasn't happened (2026-07-24 playtest — the subject
	// appeared on night one and read as nonsense).
	const isSlates = group.options.some((o) => o.claimId === 'P-s1-slates');
	if (isSlates && state.systems?.structure?.slates === 'sound') return false;
	return true;
}

/**
 * renderOption — one selectable sentence as a radio row.
 * Receives the group index, the option index, the option spec, whether it is
 *   selected, and the state (for the observation gate). Returns HTML.
 * A precise option about a fact this keeper never observed is DISABLED and
 *   annotated "(you never looked)" — the gate that stops the desk being
 *   rubber-stamped and that keeps composeEntry from ever throwing.
 */
function renderOption(groupIndex, optionIndex, option, selected, state) {
	const isPreciseLocked = option.certainty === 'precise'
		&& !statementOptions(state, optionSubject(option)).precise;
	const disabled = isPreciseLocked ? ' disabled' : '';
	const locked = isPreciseLocked ? ' <span class="desk-locked">(you never looked)</span>' : '';
	const checked = selected ? ' checked' : '';
	return `
		<label class="desk-option${isPreciseLocked ? ' is-locked' : ''}">
			<input type="radio" name="subj-${groupIndex}" value="${optionIndex}"${disabled}${checked}>
			<span class="desk-option-text">${escapeHtml(templateText(option))}</span>${locked}
		</label>`;
}

/**
 * renderSubjectGroup — one writable subject: its label, its option rows, and
 * the always-available omission.
 * Receives the group, its index, the current selection ('omit' or an option
 *   index), and the state. Returns HTML. Omission is the last row and the
 *   default, so the player opts IN to every statement — silence is the resting
 *   state of the record.
 */
function renderSubjectGroup(group, groupIndex, selection, state) {
	const options = group.options
		.map((opt, j) => renderOption(groupIndex, j, opt, selection === j, state))
		.join('');
	const omitChecked = selection === 'omit' ? ' checked' : '';
	return `
		<fieldset class="desk-subject">
			<legend>${escapeHtml(group.subjectLabel)}</legend>
			${options}
			<label class="desk-option desk-omit">
				<input type="radio" name="subj-${groupIndex}" value="omit"${omitChecked}>
				<span class="desk-option-text">Say nothing of it.</span>
			</label>
		</fieldset>`;
}

/**
 * createDesk — build the desk controller.
 * Receives { mountEl } (the #desk overlay). Returns { open(context) }.
 * open() renders the desk for one night and wires the live preview; on "Sign
 *   the page" it assembles the draft and calls context.onSign(draft) — game.js
 *   applies it through composeEntry and drives the rest of the flow.
 * Listeners are attached ONCE here (delegated on mountEl) and read a closed-over
 *   `current` that open() replaces each night, so re-rendering never leaks
 *   listeners and the desk has no lifecycle bugs across nights.
 */
export function createDesk({ mountEl }) {
	// The live desk session. Replaced wholesale by each open(); null when closed.
	let current = null;

	/**
	 * paint — (re)draw the whole desk from `current`. Called on open and after
	 *   any selection/text change so the preview always matches the controls.
	 */
	function paint() {
		if (!current) return;
		const { context, selections } = current;
		const groupsHtml = current.visibleGroups
			.map((g, i) => renderSubjectGroup(g, i, selections[i], context.state))
			.join('');
		const eventHtml = context.eventLine
			? `<p class="desk-event">${escapeHtml(context.eventLine)}</p>`
			: '';
		const sigHtml = context.needsSignature
			? `<label class="desk-sign-as">Sign as:
					<input id="desk-sig" type="text" maxlength="${MAX_SIGNATURE_CHARS}"
						value="${escapeHtml(current.signature)}" placeholder="any mark">
				</label>`
			: '';
		mountEl.innerHTML = `
			<div class="desk-inner">
				<header class="desk-header">
					<p class="desk-dateline">${escapeHtml(context.dateLabel)}</p>
					${eventHtml}
				</header>
				<div class="desk-columns">
					<div class="desk-operational">
						<h2 class="desk-h">The entry</h2>
						${groupsHtml}
						<label class="desk-note-label" for="desk-note">A line of your own, if you want one. The next keeper reads it as you wrote it.</label>
						<textarea id="desk-note" maxlength="${MAX_PERSONAL_NOTE_CHARS}" rows="4">${escapeHtml(current.note)}</textarea>
					</div>
					<div class="desk-preview-col">
						<h2 class="desk-h">The page</h2>
						<div id="desk-preview" class="desk-preview">${previewHtml()}</div>
						${sigHtml}
						<button id="desk-sign" type="button" class="desk-sign">Sign the page</button>
					</div>
				</div>
			</div>`;
	}

	/**
	 * previewHtml — the composed page as it will appear, from current selections.
	 *   Only non-omitted subjects contribute a sentence; the signature and the
	 *   personal note appear exactly where the real page will carry them.
	 */
	function previewHtml() {
		const sentences = collectSelectedOptions().map((opt) => ({ text: templateText(opt) }));
		const previewEntry = {
			dateLabel: current.context.dateLabel,
			sentences,
			signature: current.signature,
			personalNote: current.note,
		};
		return renderComposedPreview(previewEntry);
	}

	/**
	 * collectSelectedOptions — the chosen option spec per non-omitted subject, in
	 *   subject order. Shared by the preview and the draft builder so the two can
	 *   never disagree about what was chosen.
	 */
	function collectSelectedOptions() {
		const chosen = [];
		current.visibleGroups.forEach((group, i) => {
			const sel = current.selections[i];
			if (sel !== 'omit') chosen.push(group.options[sel]);
		});
		return chosen;
	}

	/**
	 * refreshPreview — repaint only the preview node (cheap; on every keystroke).
	 */
	function refreshPreview() {
		const node = mountEl.querySelector('#desk-preview');
		if (node) node.innerHTML = previewHtml();
	}

	// One delegated change listener: radio selection changes update the model
	// then refresh the preview. Values are the option index or the string 'omit'.
	mountEl.addEventListener('change', (ev) => {
		if (!current) return;
		const el = ev.target;
		if (el.name && el.name.startsWith('subj-')) {
			const groupIndex = Number(el.name.slice('subj-'.length));
			current.selections[groupIndex] = el.value === 'omit' ? 'omit' : Number(el.value);
			refreshPreview();
		}
	});

	// One delegated input listener: the personal note and the signature field
	// update the model and the preview live (maxlength on the elements enforces
	// the byte caps up front — "the UI must prevent, not catch").
	mountEl.addEventListener('input', (ev) => {
		if (!current) return;
		if (ev.target.id === 'desk-note') { current.note = ev.target.value; refreshPreview(); }
		else if (ev.target.id === 'desk-sig') { current.signature = ev.target.value; refreshPreview(); }
	});

	// Sign: assemble the draft and hand it to game.js. Only non-omitted subjects
	// contribute an operational sentence spec; each carries its statementId (for
	// the frozen text), claimId, certainty, and assertedValue — exactly what
	// composeEntry needs to freeze and tag the sentence.
	mountEl.addEventListener('click', (ev) => {
		if (!current) return;
		if (ev.target.id !== 'desk-sign') return;
		const sentences = collectSelectedOptions().map((opt) => ({
			statementId: opt.statementId,
			claimId: opt.claimId,
			certainty: opt.certainty,
			assertedValue: opt.assertedValue,
		}));
		const draft = { sentences, signature: current.signature };
		if (current.note.length > 0) draft.personalNote = current.note;
		const onSign = current.context.onSign;
		current = null; // close the session before handing off, so a stray event can't re-fire
		onSign(draft);
	});

	/**
	 * open — begin a night's writing.
	 * Receives a context:
	 *   { state, statementSet, dateLabel, eventLine, needsSignature, signature,
	 *     onSign(draft) }.
	 *   - state: the current GameState (post-sleep, post-event).
	 *   - statementSet: S1_STATEMENTS or S2_STATEMENTS.
	 *   - dateLabel: what the desk header and the composed entry show.
	 *   - eventLine: the storm narration ('guttered'/'held') or null.
	 *   - needsSignature: true on the shift's first desk (show the "Sign as" field).
	 *   - signature: the mark carried from earlier desks this shift ('' if new).
	 * Reveals the overlay and paints. Omission is the default for every subject.
	 */
	function open(context) {
		const visibleGroups = context.statementSet.filter((g) => subjectVisible(g, context.state));
		current = {
			context,
			visibleGroups,
			selections: visibleGroups.map(() => 'omit'),
			note: '',
			signature: context.signature ?? '',
		};
		// Reveal + inert + focus are owned by game.js's openOverlay (QA-2026-07-24
		// CR-1): ONE choke point for every book-side overlay. This controller only
		// renders its content; it no longer toggles #desk visibility itself.
		paint();
	}

	return { open };
}
