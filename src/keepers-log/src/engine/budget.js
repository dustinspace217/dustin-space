// budget.js — the F2 content validator.
//
// design-spec §3, enforcement rule 2: "Budget validation is mechanical, not
// vibes." Every day script must pass an engine-level check proving that
// verifying EVERYTHING that day is infeasible — the verify costs of the day's
// live credible claims must EXCEED the discretionary time available. If they
// don't, the day lets a player verify-everything, which collapses the trust-vs-
// verify tension the whole game is built on.
//
// This is exported so it runs in two places from one definition: the engine
// tests, and a content-CI check over the real day scripts (engine-spec §budget:
// "exported so tests AND a content CI check both call it").

/**
 * @typedef {import('./types.js').Claim} Claim
 */

/**
 * DayBudgetResult — the outcome of validateDay.
 * @typedef {Object} DayBudgetResult
 * @property {boolean} ok            True when the day is properly over-verifiable.
 * @property {string} [dayId]
 * @property {number} discretionary  tu left after mandatory duties.
 * @property {number} verifyTotal    Sum of live credible claims' verify costs.
 * @property {string[]} counted      The claim ids that were summed (for debugging a failure).
 */

/**
 * validateDay — prove a day cannot be fully verified.
 * Receives:
 *   - dayScript: { id?, dayTU, mandatoryTU, liveClaims: string[] } — the day's
 *       total waking tu, the tu its mandatory duties consume, and the ids of the
 *       claims live (in play) that day.
 *   - claims: Object<id, Claim> — the registry, for verifyCost lookups.
 * Returns a DayBudgetResult. discretionary = dayTU - mandatoryTU; verifyTotal =
 *   sum of verifyCost over the day's live CREDIBLE claims. ok is true iff
 *   verifyTotal > discretionary (strictly greater — if they were equal a player
 *   could just afford to verify all, which is the failure this guards).
 *
 * "Credible" filter: a claim is excluded from the sum when it is explicitly
 *   marked `credible === false` in the registry (a claim no reasonable keeper
 *   would spend time verifying). Everything else counts. Excluding non-credible
 *   claims makes the check HARDER to pass (a smaller sum), which is the safe
 *   direction — it never masks an over-verifiable day.
 * Throws if a listed live claim is missing from the registry (a content gap that
 *   must fail loudly in CI, not silently drop from the sum and weaken the proof).
 */
export function validateDay(dayScript, claims) {
	if (!dayScript || typeof dayScript !== 'object') throw new Error('validateDay: dayScript required');
	if (typeof dayScript.dayTU !== 'number' || typeof dayScript.mandatoryTU !== 'number') {
		throw new Error('validateDay: dayScript needs numeric dayTU and mandatoryTU');
	}
	const discretionary = dayScript.dayTU - dayScript.mandatoryTU;
	const live = Array.isArray(dayScript.liveClaims) ? dayScript.liveClaims : [];
	let verifyTotal = 0;
	const counted = [];
	for (let i = 0; i < live.length; i++) {
		const id = live[i];
		const claim = claims?.[id];
		if (!claim) throw new Error(`validateDay: live claim "${id}" not in registry`);
		if (claim.credible === false) continue;
		verifyTotal += claim.verifyCost ?? 0;
		counted.push(id);
	}
	return {
		ok: verifyTotal > discretionary,
		dayId: dayScript.id,
		discretionary,
		verifyTotal,
		counted,
	};
}

/**
 * validateAllDays — run validateDay across a whole content set.
 * Receives: an array of day scripts and the claim registry.
 * Returns: { ok, failures } where failures is the list of DayBudgetResults that
 *   did NOT pass. The content-CI check calls this to gate the whole day set in
 *   one shot; ok is true only when every day is properly over-verifiable.
 */
export function validateAllDays(dayScripts, claims) {
	const results = dayScripts.map((d) => validateDay(d, claims));
	const failures = results.filter((r) => !r.ok);
	return { ok: failures.length === 0, failures, results };
}
