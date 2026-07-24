// day.js — the action resolver: the within-a-day loop of moving, doing duties,
// verifying, acting on trust, reading, and sleeping.
//
// Every action is a PURE function: (state, params, deps) -> ActionResult. None
// mutate their input state; each returns a new one. deps carries the content
// data the engine must not import (economy costs, the claim registry) — this is
// the "content is data" seam from engine-spec.
//
// The load-bearing rule of the whole game lives in followClaim (design-spec §3:
// "Trust is behavioral, never a button"): acting on a claim you did NOT verify
// records it as trusted; acting on one you DID verify records nothing, because
// you knew. The observation-gating and interlude mechanics both hang off which
// list a claim lands in, so this distinction is the spine.

import { appendObservation, validateState, DEFAULT_DAY_TU } from './state.js';
import { walkCost, areAdjacent } from './spatial.js';
import { factKey } from './claims.js';

/**
 * @typedef {import('./types.js').GameState} GameState
 * @typedef {import('./types.js').Claim} Claim
 */

/**
 * ActionResult — the uniform shape every action returns.
 * `ok:false` means a legal-but-refused gameplay outcome (not enough time, a
 *   storm-blocked leg) and carries the ORIGINAL state unchanged plus a reason;
 *   the UI shows the reason. Contract violations (unknown claim, non-adjacent
 *   move offered) throw instead — those are bugs, not player choices.
 * @typedef {Object} ActionResult
 * @property {boolean} ok
 * @property {GameState} state
 * @property {string} [reason]
 */

/**
 * spend — internal: subtract a tu cost, refusing if unaffordable.
 * Receives a state and a cost; returns {ok, state}. Keeps the "never go below
 *   zero tu" invariant (validateState would throw on negative tu) in one place
 *   so every action refuses affordability the same way.
 */
function spend(state, cost) {
	if (cost > state.tu) return { ok: false, state, reason: `insufficient tu (need ${cost}, have ${state.tu})` };
	return { ok: true, state: { ...state, tu: state.tu - cost } };
}

/**
 * addUnique — internal: append a string to an array only if absent.
 * Receives an array and an item; returns a new array. Used for the trust /
 *   verified lists, which are naturally bounded by the finite claim registry —
 *   dedup keeps them <= registry size, so they need no explicit cap.
 */
function addUnique(list, item) {
	return list.includes(item) ? list : [...list, item];
}

/**
 * move — walk one leg to an adjacent room.
 * Receives: state, destination room id, deps (unused today but kept for a
 *   uniform action signature), and options {deliberate} for the storm risk.
 * Returns an ActionResult; on success state.room and state.tu are updated.
 * Refuses (ok:false) a storm-blocked leg unless deliberate, and an unaffordable
 *   leg. Throws only if the destination is not adjacent (an impossible move the
 *   UI should never have offered).
 */
export function move(state, to, deps = {}, { deliberate = false } = {}) {
	if (!areAdjacent(state.room, to)) throw new Error(`move: "${to}" is not adjacent to "${state.room}"`);
	const { cost, blocked } = walkCost(state.room, to, state.weather, deliberate);
	if (blocked) return { ok: false, state, reason: 'storm-blocked (pass deliberate to risk it)' };
	const paid = spend(state, cost);
	if (!paid.ok) return paid;
	return { ok: true, state: { ...paid.state, room: to } };
}

/**
 * duty — perform a mandatory duty (wind, light, douse, meal, ...).
 * Receives: state, the duty kind, deps carrying economy.duty costs.
 * Returns an ActionResult; on success records the kind in flags.dutiesDone (a
 *   PER-DAY list — advanceDay clears it, so it tracks "what has been done today",
 *   which duties still remain) and spends the economy cost. The finer effect of
 *   a duty (e.g. winding resetting the drive's run-time) is content/tuning that
 *   P3 wires through systems; the engine models the STRUCTURE — cost paid, duty
 *   recorded — not the tuned magnitude.
 * dutiesDone is deduped (QA SL-5/AT-7): doing the same duty twice in a day is one
 *   fact ("winding is done"), not two — a duplicate would misreport remaining
 *   duties and inflate the list unbounded across a long day of re-winding.
 * Throws if the kind has no cost in the economy (a content gap).
 */
export function duty(state, kind, deps = {}) {
	const cost = deps.economy?.duty?.[kind];
	if (cost === undefined) throw new Error(`duty: no economy cost for kind "${kind}"`);
	const paid = spend(state, cost);
	if (!paid.ok) return paid;
	const dutiesDone = addUnique(paid.state.flags.dutiesDone || [], kind);
	return { ok: true, state: { ...paid.state, flags: { ...paid.state.flags, dutiesDone } } };
}

/**
 * inspect — physically look at a fact, recording an Observation.
 * Receives: state, a target, deps (economy + claim registry).
 *   target = { subject, claimId? }. When claimId is given, the look is
 *   VERIFYING that claim: cost and the required room come from the claim, the
 *   observation is flagged viaVerify, and the claim id joins claimsVerified.
 *   When no claimId, it is an unforced look: cost is economy.inspectCost.
 * Returns an ActionResult; on success appends the observation (through the
 *   capped state helper) and spends the cost.
 * Why the room check: you can only observe what you are standing next to
 *   (design-spec §4 — precision's cost is the observing). Refuses (ok:false) if
 *   the keeper is not in the fact's room; throws on an unknown claimId.
 */
export function inspect(state, target, deps = {}) {
	let subject = target.subject;
	let viaVerify = false;
	let cost = deps.economy?.inspectCost ?? 1;
	let requiredRoom = subject?.room;
	if (target.claimId) {
		const claim = deps.claims?.[target.claimId];
		if (!claim) throw new Error(`inspect: unknown claim "${target.claimId}"`);
		subject = claim.subject;
		viaVerify = true;
		cost = claim.verifyCost ?? cost;
		requiredRoom = claim.verifyRoom ?? subject?.room;
	}
	if (requiredRoom && state.room !== requiredRoom) {
		return { ok: false, state, reason: `must be in "${requiredRoom}" to inspect (currently in "${state.room}")` };
	}
	const paid = spend(state, cost);
	if (!paid.ok) return paid;
	const observation = { factId: factKey(subject), room: state.room, day: state.day, viaVerify };
	let next = appendObservation(paid.state, observation);
	if (target.claimId) {
		next = { ...next, claimsVerified: addUnique(next.claimsVerified, target.claimId) };
	}
	return { ok: true, state: next };
}

/**
 * followClaim — act on a claim's instruction. THE core rule.
 * Receives: state, a claimId, deps (economy + claim registry).
 * Returns an ActionResult. The distinction that defines the game:
 *   - If the claim is already in claimsVerified, the keeper is acting on
 *     KNOWLEDGE — nothing is added to claimsTrusted.
 *   - Otherwise the keeper is acting on TESTIMONY — the claim is recorded in
 *     claimsTrusted. That record is behavioral: no button, no meter; doing the
 *     action without checking IS trusting it.
 * So two runs that differ only by a prior inspect diverge here — trusted vs
 *   verified — which is precisely the divergence the behavioral-trust test pins.
 * Cost: the action's own tu (claim.actionCost, default 0 — "acting on trust is
 *   fast"). Consequence RESOLUTION is deliberately NOT done here: engine-spec
 *   assigns that to claims.js/resolveTrust as a separate query, run at interlude
 *   time. Keeping the act (this function) and its downstream reckoning
 *   (resolveTrust) separate mirrors the game itself — you act now, the cost
 *   arrives later, in another keeper's hand.
 * Throws on an unknown claimId.
 */
export function followClaim(state, claimId, deps = {}) {
	const claim = deps.claims?.[claimId];
	if (!claim) throw new Error(`followClaim: unknown claim "${claimId}"`);
	const cost = claim.actionCost ?? 0;
	const paid = spend(state, cost);
	if (!paid.ok) return paid;
	if (state.claimsVerified.includes(claimId)) {
		return { ok: true, state: paid.state };
	}
	return { ok: true, state: { ...paid.state, claimsTrusted: addUnique(paid.state.claimsTrusted, claimId) } };
}

/**
 * readLog — read a stratum of the logbook.
 * Receives: state, the stratum key, deps (economy.readLog cost per session).
 * Returns an ActionResult; spends the reading cost and records the stratum in
 *   flags.strataRead. Recording it is the minimal faithful reading of the
 *   readLog(stratum) signature — otherwise the parameter would be inert — and
 *   gives P3 the hook it needs to gate cross-reading discoveries. No content is
 *   consumed here; reading only costs time and marks what was read.
 */
export function readLog(state, stratum, deps = {}) {
	const cost = deps.economy?.readLog ?? 1;
	const paid = spend(state, cost);
	if (!paid.ok) return paid;
	const strataRead = addUnique(paid.state.flags.strataRead || [], stratum);
	return { ok: true, state: { ...paid.state, flags: { ...paid.state.flags, strataRead } } };
}

/**
 * sleep — end the day by bedding down somewhere.
 * Receives: state, a location ('quarters' | 'watch' typically), deps carrying
 *   the economy (debuff data) — the flue's state is read from systems.
 * Returns an ActionResult. Sets flags.pendingSleepDebuff based on WHERE you
 *   slept and whether the flue is fixed (shifts.md: quarters gives a morning
 *   fog debuff from Ash's real cause until the flue is rodded; the watch-room
 *   chair avoids it at a stiffness cost). advanceDay consumes the pending flag.
 * Why sleep doesn't itself roll the day over: the next day's scripted weather is
 *   content, so day advancement is a separate function that takes the day
 *   script. sleep records intent and the debuff; advanceDay applies them.
 * The debuff MAGNITUDES are tuning — the engine records the KIND ('fog' /
 *   'stiffness' / null); numbers land at P3.
 */
export function sleep(state, location, deps = {}) {
	const flueFixed = !!state.systems?.structure?.flueFixed;
	let debuff = null;
	if (!flueFixed && location === 'quarters') debuff = 'fog';
	else if (location === 'watch') debuff = 'stiffness';
	const flags = { ...state.flags, dayEnded: true, sleptIn: location, pendingSleepDebuff: debuff };
	return { ok: true, state: { ...state, flags } };
}

/**
 * advanceDay — roll into the next day with a fresh time budget.
 * Receives: state, the next day's scripted content {day?, weather, tu?}, deps
 *   (economy for the default day length and debuff cost).
 * Returns a new VALIDATED state (not an ActionResult — this is a transition, not
 *   a player action that can be refused): day incremented, weather set from the
 *   script, tu reset to the day length minus any pending sleep-debuff tu penalty,
 *   and the per-day flags (dutiesDone, dayEnded, pendingSleepDebuff, sleptIn)
 *   cleared while durable flags (strataRead) persist.
 * tu fallback chain (QA CR-4): nextDay.tu -> economy.dayTU -> DEFAULT_DAY_TU. It
 *   MUST NOT fall back to state.tu — carrying yesterday's LEFTOVER time into a
 *   fresh day is the exact bug CR-4 pins; a new day starts full, never from the
 *   remainder. The chain ends at the named constant so an absent economy still
 *   yields a sane full day, never a stale one.
 * Output is validated (QA CR-5) so a bad script (e.g. an unknown weather) fails
 *   at the transition, not deep in the next day's actions.
 * Why here and not in state.js: advancing a day needs the ECONOMY and the day
 *   SCRIPT, which are day-domain content; state.js stays content-free.
 */
export function advanceDay(state, nextDay = {}, deps = {}) {
	const dayLength = nextDay.tu ?? deps.economy?.dayTU ?? DEFAULT_DAY_TU;
	const debuffTU = state.flags.pendingSleepDebuff ? (deps.economy?.debuffCost?.[state.flags.pendingSleepDebuff] ?? 0) : 0;
	const { dutiesDone, dayEnded, pendingSleepDebuff, sleptIn, ...durableFlags } = state.flags;
	return validateState({
		...state,
		day: nextDay.day ?? state.day + 1,
		weather: nextDay.weather ?? state.weather,
		tu: Math.max(0, dayLength - debuffTU),
		flags: durableFlags,
	});
}

/**
 * advanceShift — the KEEPER BOUNDARY: this player becomes the next keeper.
 * Receives: state, the incoming shift's script {day?, tu?, weather?, room?},
 *   deps (economy for the tu fallback).
 * Returns a new VALIDATED state.
 *
 * This is the transition the original spec never named, and whose silence
 * produced the SL-1 blocker (per-shift state leaking between keepers who, by the
 * Rule, never meet and share nothing but the station and the book). Every
 * GameState field is ruled on EXPLICITLY here — the amended spec forbids
 * deciding a field by omission:
 *   CLEARED (the keeper's mind — a new keeper knows nothing, design-spec §4/§5):
 *     observations, claimsTrusted, claimsVerified, and ALL flags.
 *   PRESERVED (the station and the record, which outlive any keeper):
 *     entries (the logbook), systems (the physical world), consequenceLog
 *     (what HAPPENED — kin to systems; §5 requires the player to inherit their
 *     own downstream consequences).
 *   SET from the shift script: shiftIndex (+1), day, tu, weather, room.
 * The tu fallback ends at DEFAULT_DAY_TU (same discipline as advanceDay), never
 *   the outgoing keeper's leftover tu.
 */
export function advanceShift(state, shiftScript = {}, deps = {}) {
	const tu = shiftScript.tu ?? deps.economy?.dayTU ?? DEFAULT_DAY_TU;
	return validateState({
		...state,
		shiftIndex: state.shiftIndex + 1,
		day: shiftScript.day ?? 1,
		tu,
		weather: shiftScript.weather ?? state.weather,
		room: shiftScript.room ?? state.room,
		// Cleared: the new keeper's blank slate.
		observations: [],
		claimsTrusted: [],
		claimsVerified: [],
		flags: {},
		// Preserved by NOT overriding: entries, systems, consequenceLog carry
		// through from `...state` untouched — the station's memory persists.
	});
}
