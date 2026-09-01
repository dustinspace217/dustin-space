// ANALYSIS RUN SETTINGS — the single home for the two numbers that define "the
// standard run" of this project's ladder.
//
// WHY this module exists (QA 2026-09-01, converged finding CR-1/TA-2): these two
// constants used to live in three independent copies — js/main.js, scripts/
// report-ladder.js, and tools/verify-page-numbers.mjs — which happened to agree.
// The verification tool was therefore validating its own private copy of the run
// settings rather than the settings the page actually uses: if main.js changed its
// seed, the tool would keep comparing two reconstructions that agreed with each
// other and exit 0 while the page diverged from the committed report. One shared
// module makes that drift impossible rather than merely unlikely.
//
// This file must stay import-safe EVERYWHERE: no DOM, no node builtins, no side
// effects — it is loaded by the browser page, by node scripts, and by the verify
// tool alike.

// Null models built per rung. The offline report and the page must use the same
// count, or their numbers legitimately differ and every comparison is noise.
export const SURROGATES = 25;

// Fixed RNG seed: the date the ladder design was settled. Same seed everywhere is
// what makes "the page and the command line produce the same ladder" true.
export const SEED = 20260728;
