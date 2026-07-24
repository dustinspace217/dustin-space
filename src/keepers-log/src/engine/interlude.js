// interlude.js — the authored consequence graph consumer.
//
// Between player shifts, a simulated NPC keeper acts on the log — including the
// player's own entries — and writes their own. design-spec §5 is emphatic that
// this is a FINITE AUTHORED graph, not a generative simulator: for each
// load-bearing player claim, the engine SELECTS an authored variant and splices
// the player's exact operational sentence into authored NPC text. There is no
// text generation here — only selection and verbatim splicing.
//
// Determinism is the whole contract (engine-spec test list: "same claims+state
// => byte-identical NPC entries"). This module uses no RNG, no Date, and a
// stable iteration order (the script's own order), so identical inputs always
// yield identical output.

import { appendEntry, appendConsequence } from './state.js';

/**
 * @typedef {import('./types.js').GameState} GameState
 * @typedef {import('./types.js').Entry} Entry
 * @typedef {import('./types.js').Sentence} Sentence
 */

// The token an authored NPC template uses to mark where the player's verbatim
// sentence is spliced in. Chosen as a double-brace form no prose would contain.
export const QUOTE_TOKEN = '{{quote}}';

/**
 * selectVariant — map a player sentence's engine tags to one of the four
 * authored downstream strokes (design-spec §5):
 *   - precise TRUE instruction  -> 'followed'   (maintained; NPC notes gratitude)
 *   - a lie (precise FALSE)      -> 'propagated' (NPC builds on the false claim)
 *   - anything vague             -> 'misread'    (garbled or ignored)
 *   - (absence handled by caller) -> 'ambush'    (OMISSION: the successor is caught out)
 * Receives the sentence's tags; returns a variant key string.
 * Why the four fixed strokes: they are the authored branches the content bible
 *   promises, so the engine's job is only to route to them, not to invent
 *   nuance. A precise statement with unknown veracity (no assertedValue) routes
 *   to 'followed' — the successor takes a confident instruction at face value.
 */
export function selectVariant(tags) {
	if (!tags || tags.precision === 'vague') return 'misread';
	if (tags.precision === 'guess') return 'misread';
	if (tags.veracity === 'FALSE') return 'propagated';
	return 'followed';
}

/**
 * findPlayerSentence — locate the player's BINDING sentence about one fact.
 * Receives: state, and a load-bearing item carrying a claimHook (the claimId the
 *   NPC beat responds to). Returns the matching Sentence, or null if the player
 *   wrote nothing about it (the OMISSION case).
 * Returns the LAST match in reading order, not the first (QA AT-9 author ruling):
 *   a keeper's final word on a claim is binding testimony. A later precise
 *   correction must SUPERSEDE an earlier vague line — the successor reads the log
 *   whole and acts on the corrected record, so the interlude must route on the
 *   correction, not the superseded draft. (A first-match implementation would let
 *   an early hedge shadow a deliberate fix — the revert this pins.)
 * Bounded by the entry/sentence counts (both engine-capped).
 */
function findPlayerSentence(state, item) {
	let found = null;
	for (const entry of state.entries) {
		for (const sentence of entry.sentences) {
			if (sentence.claimId && sentence.claimId === item.claimHook) found = sentence;
		}
	}
	return found;
}

/**
 * spliceQuote — insert the player's verbatim sentence into an authored template.
 * Receives: the authored template string, the player's sentence text.
 * Returns the template with every QUOTE_TOKEN replaced by the exact player text.
 * Uses a FUNCTION replacement, not a string one. A string replacement would let
 *   the player's own words trigger special replacement patterns ($&, $1, $$) and
 *   silently rewrite themselves — a `$&` in a keeper's note would expand to the
 *   matched token. Returning the quote from a function inserts it literally and
 *   byte-exact, which is the whole point of the mechanic: the sentence you signed
 *   is the sentence that comes back.
 */
function spliceQuote(template, quote) {
	return template.replaceAll(QUOTE_TOKEN, () => quote);
}

/**
 * runInterlude — render one NPC keeper's term as authored consequences.
 * Receives:
 *   - state: the state after the player's shift.
 *   - script: { npcKeeperId, dateLabel, loadBearing: [ item ] } where each item
 *       = { claimHook, variants: { followed?, misread?, propagated?, ambush? } }
 *       and each variant = { template, delta?, nodeId? }. `template` is authored
 *       NPC prose (with QUOTE_TOKEN where a player quote belongs); `delta` is a
 *       partial systems patch the variant applies; `nodeId` is the graph node id
 *       to record in the consequence log.
 *   - deps: reserved for future content needs (unused today).
 * Returns a NEW state with: one NPC Entry appended per load-bearing item, each
 *   variant's systems delta merged in, and each fired nodeId appended to the
 *   consequence log.
 *
 * For each item: find the player's sentence; if present, select the variant from
 *   its tags and splice its verbatim text into that variant's template; if
 *   absent, use the 'ambush' variant (the omission beat). Selection and splicing
 *   only — no generated text. Deterministic by construction: fixed iteration
 *   order, no randomness.
 */
export function runInterlude(state, script, deps = {}) {
	let next = state;
	const items = Array.isArray(script.loadBearing) ? script.loadBearing : [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const playerSentence = findPlayerSentence(next, item);
		const variantKey = playerSentence ? selectVariant(playerSentence.tags) : 'ambush';
		const variant = item.variants?.[variantKey];
		if (!variant) throw new Error(`interlude: item for "${item.claimHook}" has no "${variantKey}" variant`);
		const quote = playerSentence ? playerSentence.text : '';
		/** @type {Sentence[]} */
		const sentences = [{ text: spliceQuote(variant.template, quote), claimId: null }];
		/** @type {Entry} */
		const entry = {
			id: `${script.npcKeeperId}-${item.claimHook}-${variantKey}`,
			keeperId: script.npcKeeperId,
			dateLabel: script.dateLabel,
			layer: 'operational',
			sentences,
			signature: script.npcKeeperId,
		};
		next = appendEntry(next, entry);
		if (variant.delta) next = { ...next, systems: mergeSystems(next.systems, variant.delta) };
		if (variant.nodeId) next = appendConsequence(next, variant.nodeId);
	}
	return next;
}

/**
 * mergeSystems — shallow-per-system merge of a delta patch into systems.
 * Receives: the current systems object and a delta {system: {aspect: value}}.
 * Returns a new systems object with each delta system merged over the current
 *   one (aspect-level override). A shallow two-level merge matches the systems
 *   shape (system -> {aspect: value}) and avoids a deep-merge library; deeper
 *   nesting isn't part of the content model, so two levels is sufficient.
 */
function mergeSystems(systems, delta) {
	const out = { ...systems };
	for (const system of Object.keys(delta)) {
		out[system] = { ...(systems[system] || {}), ...delta[system] };
	}
	return out;
}

// The variant keys whose templates SPLICE a player quote and therefore MUST
// contain the token. 'ambush' is excluded on purpose: it fires on an OMISSION,
// where the player wrote nothing, so it quotes nothing (QA AT-8 exemption).
const QUOTING_VARIANTS = ['followed', 'misread', 'propagated'];

/**
 * validateInterludeScript — content-CI check that every quoting variant actually
 * quotes. Sibling to budget.js's validateDay (same content-CI pattern): a
 * can-fail validator a test AND a CI pass both call.
 * Receives: an interlude script { loadBearing: [ { claimHook, variants } ] }.
 * Returns: { ok, failures } where each failure is { claimHook, variant, reason }.
 * The bug it guards (AT-8): an authored 'followed'/'misread'/'propagated'
 *   template that forgot the QUOTE_TOKEN would SILENTLY DROP the player's
 *   sentence — the whole "your words come back" mechanic, gone, with no error.
 *   Here it fails loudly at content-build time instead. 'ambush' is exempt.
 * ok is true only when every quoting variant present contains the token.
 */
export function validateInterludeScript(script) {
	const items = Array.isArray(script?.loadBearing) ? script.loadBearing : [];
	const failures = [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const variants = item.variants || {};
		for (let v = 0; v < QUOTING_VARIANTS.length; v++) {
			const key = QUOTING_VARIANTS[v];
			const variant = variants[key];
			if (!variant) continue; // a script need not author every variant
			if (typeof variant.template !== 'string' || !variant.template.includes(QUOTE_TOKEN)) {
				failures.push({ claimHook: item.claimHook, variant: key, reason: 'template missing QUOTE_TOKEN' });
			}
		}
	}
	return { ok: failures.length === 0, failures };
}
