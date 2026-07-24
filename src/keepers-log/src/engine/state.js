// state.js — construct, validate, (de)serialize GameState, and enforce the
// engine's hard memory caps.
//
// Why this module owns the caps: engine-spec's "Bounded" ground rule requires
// that the entry list, observation record, and consequence log all have hard
// caps that throw loudly if exceeded. Centralising the guarded append helpers
// here (rather than letting day.js / desk.js / interlude.js each push directly)
// means there is exactly ONE place a growth bound can be bypassed, and it can't:
// every append goes through these functions. This is Power-of-Ten §3 (bound
// memory growth) made mechanical instead of hoped-for.

/**
 * @typedef {import('./types.js').GameState} GameState
 * @typedef {import('./types.js').Entry} Entry
 * @typedef {import('./types.js').Observation} Observation
 */

// Hard caps. These are SAFETY bounds, not gameplay limits — a real playthrough
// writes far fewer of each. They exist so a bug that appends in a loop fails
// loudly and immediately instead of silently exhausting memory. Exported so
// tests can pin the exact boundary (the caps test loops to cap+1).
export const MAX_ENTRIES = 500;
export const MAX_OBSERVATIONS = 1000;
export const MAX_CONSEQUENCE_LOG = 2000;

// Structural default for a day's waking time-units (shifts.md: "A day = 12 tu").
// This is a tuning number, overridable by the economy object content passes in;
// it lives here only so createState has a sane starting tu when none is given.
export const DEFAULT_DAY_TU = 12;

const WEATHERS = new Set(['clear', 'fog', 'blow', 'storm']);
const LAYERS = new Set(['operational', 'personal']);

/**
 * createState — build a fully-formed GameState from a partial init object.
 * Receives: an optional partial state (any subset of fields).
 * Returns: a new GameState with every field present and every collection an
 *   array/object (never undefined), so the object is immediately serializable
 *   and validateState can assert a total shape.
 * Why total defaults: engine-spec requires a single serializable object and a
 *   clean serialize->deserialize->deep-equal round trip. Leaving a field
 *   undefined would make it vanish through JSON and break that round trip, so we
 *   normalise here at the one construction site rather than defending downstream.
 */
export function createState(init = {}) {
	const state = {
		shiftIndex: init.shiftIndex ?? 0,
		day: init.day ?? 1,
		tu: init.tu ?? DEFAULT_DAY_TU,
		room: init.room ?? 'watch',
		weather: init.weather ?? 'clear',
		systems: init.systems ? structuredClone(init.systems) : {},
		observations: init.observations ? [...init.observations] : [],
		entries: init.entries ? [...init.entries] : [],
		claimsTrusted: init.claimsTrusted ? [...init.claimsTrusted] : [],
		claimsVerified: init.claimsVerified ? [...init.claimsVerified] : [],
		consequenceLog: init.consequenceLog ? [...init.consequenceLog] : [],
		flags: init.flags ? structuredClone(init.flags) : {},
	};
	validateState(state);
	return state;
}

/**
 * validateState — assert the invariants the rest of the engine depends on.
 * Receives: a candidate state object.
 * Returns: the same object on success; throws Error with context on any
 *   violation (Power-of-Ten §5: check trust-boundary assumptions, recover
 *   explicitly — here recovery is a loud throw so a malformed save or a buggy
 *   producer surfaces at once rather than corrupting a run).
 */
export function validateState(state) {
	if (!state || typeof state !== 'object') throw new Error('state must be an object');
	if (!Number.isInteger(state.shiftIndex) || state.shiftIndex < 0) throw new Error('shiftIndex must be a non-negative integer');
	if (!Number.isInteger(state.day) || state.day < 1) throw new Error('day must be an integer >= 1');
	if (typeof state.tu !== 'number' || state.tu < 0) throw new Error('tu must be a number >= 0');
	if (typeof state.room !== 'string' || !state.room) throw new Error('room must be a non-empty string');
	if (!WEATHERS.has(state.weather)) throw new Error(`weather must be one of ${[...WEATHERS].join('/')}, got ${state.weather}`);
	for (const key of ['observations', 'entries', 'claimsTrusted', 'claimsVerified', 'consequenceLog']) {
		if (!Array.isArray(state[key])) throw new Error(`${key} must be an array`);
	}
	// Caps are invariants too. Note the boundary: a collection sitting EXACTLY
	// at its cap is full-but-valid (validation uses "> cap"); it is a further
	// APPEND that is refused (the append helpers use ">= cap"). Using the same
	// ">=" here would wrongly reject a legitimately full state.
	assertNotOverCap(state.entries.length, MAX_ENTRIES, 'entries');
	assertNotOverCap(state.observations.length, MAX_OBSERVATIONS, 'observations');
	assertNotOverCap(state.consequenceLog.length, MAX_CONSEQUENCE_LOG, 'consequenceLog');
	// Entry SHAPE is an invariant. A malformed entry loaded from a corrupt save
	// or an old archive must fail HERE (the deserialize/load boundary), with a
	// clear message, not survive to crash the interlude far from its cause
	// (QA AT-12). One bad entry taints the whole state — refuse, don't ingest.
	for (let i = 0; i < state.entries.length; i++) {
		if (!isValidEntry(state.entries[i])) throw new Error(`entries[${i}] is malformed (bad id/keeperId/dateLabel/layer/sentences/signature)`);
	}
	return state;
}

/**
 * isValidEntry — is this object a well-formed log Entry?
 * Receives any value; returns boolean (never throws — it is a predicate used at
 *   trust boundaries where the CALLER decides how to react: validateState throws,
 *   persist.loadArchive reports 'corrupt').
 * Checks the required Entry fields and that every sentence is {text:string,
 *   claimId:string|null} plus optional composition/tags. This is deliberately
 *   structural, not semantic — it catches corruption and version-skew garbage,
 *   not authored-content mistakes (those are P3's concern).
 */
export function isValidEntry(entry) {
	if (!entry || typeof entry !== 'object') return false;
	if (typeof entry.id !== 'string') return false;
	if (typeof entry.keeperId !== 'string') return false;
	if (typeof entry.dateLabel !== 'string') return false;
	if (entry.layer !== 'operational' && entry.layer !== 'personal') return false;
	if (typeof entry.signature !== 'string') return false;
	if (!Array.isArray(entry.sentences)) return false;
	for (const s of entry.sentences) {
		if (!s || typeof s !== 'object') return false;
		if (typeof s.text !== 'string') return false;
		if (!(s.claimId === null || typeof s.claimId === 'string')) return false;
	}
	if (entry.personalNote !== undefined && typeof entry.personalNote !== 'string') return false;
	return true;
}

/**
 * assertUnderCap — internal guard used by both validation and the append
 * helpers. Receives a current length, the cap, and a label; throws the loud,
 * uniform cap error when length would meet or exceed the cap.
 * Why a shared helper: the caps test asserts on the exact message shape, and a
 *   single source keeps validate/append messages identical.
 */
function assertUnderCap(length, cap, label) {
	if (length >= cap) {
		throw new Error(`ENGINE CAP EXCEEDED: ${label} reached hard limit of ${cap} (this is a bug, not a truncation)`);
	}
}

/**
 * assertNotOverCap — validation-side guard: a state is corrupt only if a capped
 * collection has grown PAST the cap. A collection exactly at the cap is full and
 * valid. Receives length, cap, label; throws the same loud cap error if
 * length > cap.
 */
function assertNotOverCap(length, cap, label) {
	if (length > cap) {
		throw new Error(`ENGINE CAP EXCEEDED: ${label} reached hard limit of ${cap} (this is a bug, not a truncation)`);
	}
}

/**
 * appendEntry / appendObservation / appendConsequence — the ONLY sanctioned way
 * to grow the three capped collections. Each returns a NEW state (pure; never
 * mutates the input, so callers stay referentially safe) with the item appended,
 * or throws the loud cap error if the collection is full.
 */
export function appendEntry(state, entry) {
	assertUnderCap(state.entries.length, MAX_ENTRIES, 'entries');
	return { ...state, entries: [...state.entries, entry] };
}

export function appendObservation(state, observation) {
	assertUnderCap(state.observations.length, MAX_OBSERVATIONS, 'observations');
	return { ...state, observations: [...state.observations, observation] };
}

export function appendConsequence(state, nodeId) {
	assertUnderCap(state.consequenceLog.length, MAX_CONSEQUENCE_LOG, 'consequenceLog');
	return { ...state, consequenceLog: [...state.consequenceLog, nodeId] };
}

/**
 * serialize — turn a GameState into a storage string.
 * Receives a state; returns a JSON string. We JSON-stringify rather than invent
 * a bespoke format because the state is deliberately plain-data (no functions,
 * no class instances) — the round-trip test guarantees nothing is lost.
 */
export function serialize(state) {
	return JSON.stringify(state);
}

/**
 * deserialize — reconstruct a validated GameState from a storage string.
 * Receives a JSON string; returns a DISCRIMINATED RESULT:
 *   { ok:true, state } on success, or
 *   { ok:false, error:{ reason:'corrupt'|'invalid', detail } } on failure.
 * Why a result, not a throw (QA SL-3): this sits at the storage trust boundary,
 *   where the bytes come from localStorage — possibly truncated, hand-edited, or
 *   written by a future build. An unguarded JSON.parse would throw a bare
 *   SyntaxError with no context; callers (loadRun) need a clear, catchable
 *   outcome so they can preserve the on-disk bytes instead of guessing. 'corrupt'
 *   = unparseable JSON; 'invalid' = parses but fails the state invariants
 *   (including malformed entries, per isValidEntry).
 */
export function deserialize(str) {
	let raw;
	try {
		raw = JSON.parse(str);
	} catch (e) {
		return { ok: false, error: { reason: 'corrupt', detail: e.message } };
	}
	try {
		return { ok: true, state: createState(raw) };
	} catch (e) {
		return { ok: false, error: { reason: 'invalid', detail: e.message } };
	}
}
