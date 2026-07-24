// desk.js — the writing desk: what statements a keeper may compose, and the
// assembly of an Entry from the keeper's choices.
//
// This module encodes design-spec §4's load-bearing rule, observation-gated
// precision: a PRECISE statement can only be composed about something this
// keeper OBSERVED or VERIFIED this shift. The uninformed can only write vaguely,
// guess, or omit. Precision's cost is therefore the observation behind it — the
// desk cannot be rubber-stamped, and the gate reads the observation record at
// composition time only (never retroactively — a past entry is immutable data).

import { appendEntry } from './state.js';
import { factKey, readAspect } from './claims.js';

/**
 * @typedef {import('./types.js').GameState} GameState
 * @typedef {import('./types.js').Subject} Subject
 * @typedef {import('./types.js').Entry} Entry
 * @typedef {import('./types.js').Sentence} Sentence
 */

// Byte/size caps enforced at the desk (QA AT-5-bytes / AT-6). The count caps in
// state.js bound HOW MANY entries/observations exist; these bound how BIG a single
// entry is, so a pathological composer (or a P4 UI bug) cannot smuggle a
// megabyte of text into one capped-count entry. The UI will pre-limit at P4;
// the engine throws loudly as the backstop. Exported so tests pin the exact
// boundary rather than a magic number.
export const MAX_SENTENCE_CHARS = 1000;
export const MAX_PERSONAL_NOTE_CHARS = 4000;
export const MAX_SENTENCES_PER_ENTRY = 50;

/**
 * statementOptions — which composition options are available for one subject.
 * Receives: state, a Subject.
 * Returns: { precise, vague, guess, omit } booleans. `precise` is true ONLY when
 *   an observation for this fact exists in the CURRENT record; the other three
 *   are always available (you may always be vague, guess, or say nothing).
 * Why it reads live observations and takes no entry: the gate is a function of
 *   what the keeper knows NOW. It cannot look at, and cannot alter, entries
 *   already written — that immutability is what makes "write vague day 1,
 *   observe day 2, day-1 entry unchanged" hold by construction.
 */
export function statementOptions(state, subject) {
	const key = factKey(subject);
	const observed = state.observations.some((o) => o.factId === key);
	return { precise: observed, vague: true, guess: true, omit: true };
}

/**
 * tagStatement — compute the engine tags for one operational statement.
 * Receives: state, a draft sentence spec {subject?, certainty, assertedValue?}.
 * Returns SentenceTags {precision, veracity, disclosure}.
 *   - precision comes straight from the chosen certainty.
 *   - veracity compares the asserted value to the station's ground truth
 *     (readAspect); it is null when the statement asserts nothing checkable
 *     (a vague line, or one with no assertedValue). This is the TRUE/FALSE the
 *     interlude routes on.
 *   - disclosure is always 'report' — a written sentence reports; OMISSION is
 *     the absence of a sentence and is detected by the interlude, not tagged here.
 */
export function tagStatement(state, spec) {
	const precision = spec.certainty;
	let veracity = null;
	if (spec.certainty === 'precise' && spec.subject && Object.prototype.hasOwnProperty.call(spec, 'assertedValue')) {
		const truth = readAspect(state, spec.subject);
		veracity = spec.assertedValue === truth ? 'TRUE' : 'FALSE';
	}
	return { precision, veracity, disclosure: 'report' };
}

/**
 * resolveText — the verbatim text of a statement.
 * Receives: a draft sentence spec, deps carrying content templates.
 * Returns the exact string to store. If the spec already carries explicit text
 *   (a free personal line, or a test fixture), that is used verbatim; otherwise
 *   the text is looked up from deps.templates keyed by `${statementId}|${certainty}`.
 * Why store verbatim: downstream keepers QUOTE the sentence you signed, byte for
 *   byte (design-spec §4). The engine must therefore freeze the actual string at
 *   composition time — it never regenerates text from ids later, because a
 *   template edit in a future version must not silently rewrite a past quote.
 * Throws if neither explicit text nor a matching template exists — a missing
 *   template is a content gap that should fail loudly in the test/CI pass.
 */
function resolveText(spec, deps) {
	if (typeof spec.text === 'string') return spec.text;
	const key = `${spec.statementId}|${spec.certainty}`;
	const text = deps.templates?.[key];
	if (typeof text !== 'string') throw new Error(`desk: no template text for "${key}"`);
	return text;
}

/**
 * resolveSubject — find the subject a statement concerns.
 * Receives: a sentence spec and deps (with the claim registry).
 * Returns the Subject from the spec, else the referenced claim's subject, else
 *   undefined. The desk gate keys on claim IDENTITY (QA AT-1/CR-6): a precise
 *   sentence that names a claimId inherits that claim's subject even if the spec
 *   omits it, so an author cannot dodge the observation gate by leaving `subject`
 *   off a claim-bearing precise line.
 */
function resolveSubject(spec, deps) {
	const claimSubject = spec.claimId ? deps.claims?.[spec.claimId]?.subject : undefined;
	// A spec that names BOTH an inline subject and a claim whose subject differs
	// is malformed testimony: the gate/veracity would check one fact while the
	// interlude routes it as the other claim's statement. Fail loudly at the desk
	// (same convention as the tag-completeness throws) rather than silently
	// preferring either. Stabilization-review hardening, 2026-07-23.
	if (spec.subject && claimSubject && factKey(spec.subject) !== factKey(claimSubject)) {
		throw new Error(`desk: sentence subject (${factKey(spec.subject)}) contradicts claim "${spec.claimId}"'s subject (${factKey(claimSubject)})`);
	}
	if (spec.subject) return spec.subject;
	if (claimSubject) return claimSubject;
	return undefined;
}

/**
 * composeEntry — assemble and append a signed log Entry.
 * Receives: state, a draft, deps (templates + the claim registry for subject
 *   resolution).
 *   draft = { id, keeperId, dateLabel, layer, signature, personalNote?,
 *             sentences: [ operational sentence specs ] }.
 *   Each operational sentence spec: { statementId?, text?, claimId?, subject?,
 *             certainty, assertedValue?, composition? }.
 * Returns a NEW state with the entry appended through the capped helper.
 *
 * TAG-COMPLETENESS INVARIANT (QA AT-1/CR-6): a malformed operational sentence
 *   must never freeze into the permanent record, because a bad tag misroutes the
 *   interlude downstream (a subject-less "precise" fabrication tagged veracity
 *   null was routing to the MOST-trusting 'followed' stroke — rewarded lying).
 *   So composeEntry THROWS when:
 *     - a sentence carries a claimId but no certainty (an untagged claim would
 *       route unpredictably), or
 *     - a 'precise' sentence has no resolvable subject (via spec or claimId), or
 *     - a 'precise' sentence has a subject the keeper never observed
 *       (the rubber-stamp gate).
 *   Vague/guess lines are always allowed. Each operational sentence is frozen
 *   with its verbatim text, claimId, composition metadata, and the engine tags
 *   the interlude routes on. Byte caps and the sentence-count ceiling are
 *   enforced here as loud throws. The optional personalNote is stored verbatim,
 *   carries no claim ever (the two-layer desk), and is byte-capped too.
 */
export function composeEntry(state, draft, deps = {}) {
	const sentences = [];
	const sentenceCount = Array.isArray(draft.sentences) ? draft.sentences.length : 0;
	if (sentenceCount > MAX_SENTENCES_PER_ENTRY) {
		throw new Error(`desk: entry has ${sentenceCount} sentences, over the ceiling of ${MAX_SENTENCES_PER_ENTRY}`);
	}
	for (let i = 0; i < sentenceCount; i++) {
		const spec = draft.sentences[i];
		if (spec.claimId != null && spec.certainty == null) {
			throw new Error(`desk: operational sentence with claimId "${spec.claimId}" must declare a certainty`);
		}
		const subject = resolveSubject(spec, deps);
		if (spec.certainty === 'precise') {
			if (!subject) throw new Error('desk: a precise statement needs a resolvable subject (spec.subject or a claimId with one)');
			if (!statementOptions(state, subject).precise) {
				throw new Error(`desk: cannot compose a precise statement about an unobserved fact (${factKey(subject)})`);
			}
		}
		const text = resolveText(spec, deps);
		if (text.length > MAX_SENTENCE_CHARS) {
			throw new Error(`desk: sentence text is ${text.length} chars, over the cap of ${MAX_SENTENCE_CHARS}`);
		}
		/** @type {Sentence} */
		const sentence = { text, claimId: spec.claimId ?? null };
		if (spec.composition) sentence.composition = spec.composition;
		// Tag against the RESOLVED subject so veracity is computed on the fact the
		// claim actually names, not just what the spec spelled out inline.
		if (spec.certainty) sentence.tags = tagStatement(state, { ...spec, subject });
		sentences.push(sentence);
	}
	/** @type {Entry} */
	const entry = {
		id: draft.id,
		keeperId: draft.keeperId,
		dateLabel: draft.dateLabel,
		layer: draft.layer ?? 'operational',
		sentences,
		signature: draft.signature,
	};
	// Personal note: free text, verbatim, unparsed, never a claim — but byte-capped.
	if (typeof draft.personalNote === 'string') {
		if (draft.personalNote.length > MAX_PERSONAL_NOTE_CHARS) {
			throw new Error(`desk: personal note is ${draft.personalNote.length} chars, over the cap of ${MAX_PERSONAL_NOTE_CHARS}`);
		}
		entry.personalNote = draft.personalNote;
	}
	return appendEntry(state, entry);
}
