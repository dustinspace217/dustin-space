// claims.js — the claim registry helpers and truth resolution.
//
// Two responsibilities: (1) the identity of a "fact" — the key that ties a
// claim's subject to an observation, shared by day.js (inspect) and desk.js
// (precision gating), so both agree byte-for-byte on what "the same fact" means;
// (2) resolveTrust, which maps a claim + the CURRENT station state to an
// authored consequence-graph node id.
//
// Design principle (engine-spec §4): "staleness is data, not code." This module
// never computes whether a claim is stale by comparing years. The claim's tag
// and its authored `consequences` map carry the truth; resolveTrust only reads
// the live system state to pick which authored node fires. That keeps all
// narrative judgement in content and out of the engine.

/**
 * @typedef {import('./types.js').Claim} Claim
 * @typedef {import('./types.js').Subject} Subject
 * @typedef {import('./types.js').GameState} GameState
 */

/**
 * factKey — the stable, COLLISION-PROOF identity of the fact a subject points at.
 * Receives a Subject {system, room, aspect}; returns a string key.
 * Why derived (not a stored field): observations and claims must key on the
 *   SAME identity for precision gating to work, and deriving it from the subject
 *   triple guarantees they can never disagree.
 * Why JSON.stringify of an explicit [system, room, aspect] tuple rather than a
 *   `${a}|${b}|${c}` join (the QA revert this pins, AT-10): a delimiter join
 *   aliases distinct subjects. A missing field and an empty-string field both
 *   collapse to "" ({system:'clock',aspect:'x'} == {system:'clock',room:'',aspect:'x'}),
 *   and any id containing the delimiter shifts the boundaries. JSON encodes null
 *   distinctly from "" and escapes the separator, so no two different subjects
 *   can ever produce the same key. Missing parts become null (not ""), keeping
 *   "unset" and "empty" separable.
 */
export function factKey(subject) {
	if (!subject || typeof subject !== 'object') throw new Error('factKey requires a subject object');
	return JSON.stringify([subject.system ?? null, subject.room ?? null, subject.aspect ?? null]);
}

/**
 * readAspect — the current ground-truth value of a subject's aspect.
 * Receives a state and a subject; returns the value at
 *   state.systems[system][aspect], or undefined if absent.
 * Used by resolveTrust (to pick a consequence context) and by desk.js (to tag a
 *   player statement TRUE/FALSE against what the station actually is). Kept here
 *   so "how the engine reads the world" has one definition.
 */
export function readAspect(state, subject) {
	if (!subject || !subject.system) return undefined;
	const sys = state.systems?.[subject.system];
	if (!sys || typeof sys !== 'object') return undefined;
	return subject.aspect ? sys[subject.aspect] : undefined;
}

/**
 * resolveTrust — which consequence node fires if this claim is acted upon now.
 * Receives: a claimId, the current state, and the claim registry
 *   (Object<id,Claim>). Returns the authored graph node id (a string).
 * How selection works: the claim carries a `consequences` map keyed by CONTEXT.
 *   The context key is the current value of the claim's subject aspect in the
 *   live state (stringified) — so the SAME claim resolves differently once the
 *   world has moved on (e.g. a clock "repaired" vs "slow"), which is exactly the
 *   stale-claim mechanic (V-2 superseded by O-1) expressed as data. A "default"
 *   key covers claims whose consequence doesn't depend on live state.
 * Throws on an unknown claim or a missing node — a content gap should fail loud
 *   in the CI/test pass, not resolve to undefined at runtime.
 */
export function resolveTrust(claimId, state, registry) {
	const claim = registry?.[claimId];
	if (!claim) throw new Error(`resolveTrust: unknown claim "${claimId}"`);
	const consequences = claim.consequences || {};
	const contextValue = readAspect(state, claim.subject);
	const contextKey = contextValue === undefined ? undefined : String(contextValue);
	// Prefer a context-specific node; fall back to the authored default.
	let node;
	if (contextKey !== undefined && Object.prototype.hasOwnProperty.call(consequences, contextKey)) {
		node = consequences[contextKey];
	} else if (Object.prototype.hasOwnProperty.call(consequences, 'default')) {
		node = consequences.default;
	}
	if (node === undefined) {
		throw new Error(`resolveTrust: claim "${claimId}" has no consequence node for context "${contextKey ?? 'default'}"`);
	}
	return node;
}
