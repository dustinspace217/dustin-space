// types.js — JSDoc typedefs for the engine's data model.
//
// This file is documentation-as-code: it defines the SHAPE of every object the
// engine passes around, but emits no runtime code (no classes, no TS). We use
// JSDoc typedefs rather than TypeScript because the project ships with no build
// step (see CLAUDE.md stack decision) — the types must be checkable by an editor
// and by human readers without a compiler, and must vanish entirely at runtime.
//
// Nothing imports from here; the typedefs are referenced by name in other
// modules' JSDoc. The engine treats content as data (engine-spec "Content is
// data"), so these types describe the arguments the engine RECEIVES — the
// content that fills them lands in Phase 3.

/**
 * A Claim — a statement in the log whose truth the engine knows.
 * Authored claims (Voss, Okafor, ...) live in a registry; player claims are
 * recorded as operational sentences inside Entry objects (see Sentence).
 *
 * @typedef {Object} Claim
 * @property {string} id            Stable id, e.g. "V-1", "O-2".
 * @property {string} [author]      Keeper id who wrote it.
 * @property {number} [stratum]     Year the claim was written (data, not logic).
 * @property {ClaimTag} tag         Routing tag; staleness/truth is DATA here.
 * @property {Subject} subject       What system/room/aspect the claim points at.
 * @property {number} [verifyCost]  Time-units to verify at the object.
 * @property {string} [verifyRoom]  Room where verification physically happens.
 * @property {Object<string,string>} [consequences]  context-key -> graph node id.
 * @property {number} [actionCost]  tu cost of ACTING on the claim (followClaim).
 *   Distinct from verifyCost: acting on trust is "fast, risky" (design-spec §3),
 *   so this defaults to 0/small while verifyCost is the price of checking. Kept
 *   as data so P3 tunes the trust-vs-verify asymmetry without touching engine code.
 * @property {boolean} [credible]  When false, the F2 budget validator EXCLUDES
 *   this claim from the "verify-everything" sum (budget.js). A claim no sane
 *   keeper would spend time verifying must not inflate the discretionary-time
 *   proof; excluding it only makes the proof stricter, never looser.
 */

/**
 * ClaimTag — the engine's routing category for a claim. Truth is encoded by the
 * tag plus the consequences map, NOT computed from dates (engine-spec §4).
 * @typedef {"TRUE"|"FALSE"|"STALE"|"VAGUE"|"OMISSION"|"SINCERE_FALSE"|"TRUE_PARTIAL"|"TRUE_OBSCURED"} ClaimTag
 */

/**
 * Subject — routing metadata locating a claim against the verifiable world.
 * The triple (system, room, aspect) also serves as the fact identity used by
 * observation gating (see claims.js factKey).
 * @typedef {Object} Subject
 * @property {string} system   e.g. "clock", "siren", "stores".
 * @property {string} [room]   Room the fact lives in.
 * @property {string} [aspect] The specific property, e.g. "offset", "count".
 */

/**
 * Composition — the metadata a player attaches to a written statement at the
 * desk. Present on player claims only (design-spec §5: the interlude selects
 * downstream variants from exactly these fields).
 * @typedef {Object} Composition
 * @property {string} [referent]  What the sentence is about.
 * @property {string} [location]  Where.
 * @property {string} [action]    What the successor is instructed to do.
 * @property {Certainty} certainty
 * @property {string} [cause]     The claimed cause (a lie lives here).
 */

/** @typedef {"precise"|"vague"|"guess"} Certainty */

/**
 * Observation — what THIS keeper has actually seen this shift. The desk's
 * precision gate reads ONLY this record (design-spec §4: no rubber-stamping).
 * @typedef {Object} Observation
 * @property {string} factId    factKey(subject) of the thing observed.
 * @property {string} room      Room it was observed in.
 * @property {number} day       Day index within the shift.
 * @property {boolean} viaVerify True when the look was verifying a claim.
 */

/**
 * Sentence — one line of a log Entry. Operational sentences carry a claimId and
 * (for player claims) composition + engine tags; personal-note text carries
 * none, ever (design-spec §4 two-layer desk).
 * @typedef {Object} Sentence
 * @property {string} text            Verbatim text; downstream quotes are byte-exact.
 * @property {string|null} claimId    Authored/player claim id, or null (personal).
 * @property {Composition} [composition] Player-claim metadata.
 * @property {SentenceTags} [tags]    Engine tags computed at composition time.
 */

/**
 * SentenceTags — engine's classification of a composed player statement, the
 * interlude's selection input (shifts.md: precise/vague; true/false; report).
 * @typedef {Object} SentenceTags
 * @property {Certainty} precision
 * @property {"TRUE"|"FALSE"|null} veracity  null when nothing verifiable is asserted.
 * @property {"report"} disclosure          A written sentence is always a report;
 *                                          omission is the ABSENCE of one.
 */

/**
 * Entry — one log page.
 * @typedef {Object} Entry
 * @property {string} id
 * @property {string} keeperId
 * @property {string} dateLabel
 * @property {"operational"|"personal"} layer
 * @property {Sentence[]} sentences
 * @property {string} [personalNote]  Free text, preserved verbatim, never parsed.
 * @property {string} signature
 */

/**
 * GameState — the single serializable state object. Everything the engine
 * mutates lives here; there is no hidden module-level state (Power-of-Ten §6).
 * @typedef {Object} GameState
 * @property {number} shiftIndex
 * @property {number} day
 * @property {number} tu               Time-units remaining today.
 * @property {string} room             Current room id.
 * @property {Weather} weather
 * @property {Object} systems          Per-station.md system state (content data).
 * @property {Observation[]} observations
 * @property {Entry[]} entries
 * @property {string[]} claimsTrusted  Append-only EVENT log: claims acted on
 *   WITHOUT verifying (the core rule). NOT a mutually-exclusive set with
 *   claimsVerified (QA AT-11, accepted): a claim can appear in BOTH — "acted on
 *   testimony at T1" and "verified at T2" are two things that both happened, and
 *   erasing the trust when a later verify lands would rubber-stamp history in
 *   reverse. Downstream (P3) binds consequences at TRUST time ("you act now, the
 *   cost arrives later"), so the trust event must persist even after a verify.
 * @property {string[]} claimsVerified Append-only EVENT log: claims inspected
 *   against ground truth (see claimsTrusted — same append-only, non-exclusive
 *   semantics).
 * @property {string[]} consequenceLog Authored-graph node ids that have fired.
 *   The STATION's history, kin to systems (not the keeper's mind) — preserved
 *   across the keeper boundary by advanceShift.
 * @property {Object} flags            Misc bookkeeping (duties done, sleep debuff, ...).
 */

/** @typedef {"clear"|"fog"|"blow"|"storm"} Weather */

/**
 * StorageAdapter — the injected persistence seam. The engine never touches
 * localStorage directly (engine-spec ground rule "Pure"); tests pass a memory
 * adapter with the same three-method shape.
 * @typedef {Object} StorageAdapter
 * @property {(key:string)=>(string|null)} getItem
 * @property {(key:string, value:string)=>void} setItem
 * @property {(key:string)=>void} removeItem
 */

// No runtime exports: this module is types only.
export {};
