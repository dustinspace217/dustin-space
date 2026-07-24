// game.js — the session controller: the state, the day loop, and the whole
// flow (cover → shifts → interludes → the finale), plus the scripted content
// events the ui-spec calls "the beat layer," plus the ONE overlay lifecycle
// choke point every book-side overlay routes through.
//
// This is the ONE place engine state lives at runtime. The engine action
// functions (move/duty/inspect/followClaim/readLog/sleep/advanceDay/
// advanceShift/composeEntry/runInterlude) are pure — they return new states —
// so this module holds the current state, replaces it on each action, and
// drives the three views (scene, actions, book/pages, desk) off it. The engine
// and content modules are untouched; this is glue.
//
// The scripted events (design-spec §5 "beat layer") that are NOT engine actions
// live here because they are content decisions the P4 layer owns: the storm's
// world-deltas, the 4-a.m. gutter (and the observation of it — the keeper LIVED
// the night, so they may write of it precisely), the flue completion, the
// cellar. The engine deliberately left these for P4 (see the content files'
// "wired at P4" notes); this module wires them.
//
// Overlay lifecycle (QA-2026-07-24 CR-1 = AT-1 + A11Y-4): EVERY book-side
// overlay — the sleep choice, the writing desk, the shift interstitial, the
// fitter notice, and every finale step — is opened through openOverlay() and
// closed through closeOverlay(). Those own #desk visibility, the `inert` barrier
// on the background, and focus in/return. Two STATE latches sit beneath the DOM
// barrier as the authoritative invariant (per A11Y: the model in state, the DOM
// guard on top): overlayOpen (actions + turnIn refuse while an overlay is up)
// and finaleTerminal (once the epilogue renders, everything refuses forever).

import { createState, appendObservation } from '../engine/state.js';
import { move, duty, inspect, followClaim, readLog, sleep, advanceDay, advanceShift } from '../engine/day.js';
import { composeEntry } from '../engine/desk.js';
import { runInterlude } from '../engine/interlude.js';
import { factKey } from '../engine/claims.js';
import { saveRun, loadRun, startNewRun, loadArchive } from '../engine/persist.js';
import { CLAIMS } from '../content/claims.js';
import { ECONOMY } from '../content/economy.js';
import { S1_STATEMENTS, S2_STATEMENTS, TEMPLATES } from '../content/desk-statements.js';
import {
	SHIFT1_DAYS, SHIFT2_DAYS, SHIFT3_DAYS, SHIFT_SCRIPTS,
	SYSTEMS_INITIAL, S1_STORM_DELTAS,
} from '../content/shifts-days.js';
import { PEARSE_INTERLUDE, REED_INTERLUDE } from '../content/interludes.js';
import { CALLUM_JOURNAL, STRATA } from '../content/founding-log.js';
import { escapeHtml } from './book.js';
import { createPages } from './pages.js';
import { createActions, STATION_ACTIONS } from './actions.js';
import { createDesk } from './deskview.js';
import { createFinale } from './finaleview.js';

// The three shifts as a flow table: the day scripts to run, the desk statement
// set, the shift's arrival script, and the interlude that follows (plus where
// the next keeper starts). Shift 3 has no interlude — it ends in the finale.
// Its statement set is empty on purpose: shift-3 day 1 is a normal desk with
// nothing operational to say (personal note only), and day 2 is THE LAST DESK
// (finaleview.js), reached by the openDeskForNight dispatch below.
const SHIFTS = [
	{ days: SHIFT1_DAYS, statementSet: S1_STATEMENTS, script: SHIFT_SCRIPTS[0], interlude: PEARSE_INTERLUDE, nextScript: SHIFT_SCRIPTS[1] },
	{ days: SHIFT2_DAYS, statementSet: S2_STATEMENTS, script: SHIFT_SCRIPTS[1], interlude: REED_INTERLUDE, nextScript: SHIFT_SCRIPTS[2] },
	{ days: SHIFT3_DAYS, statementSet: [], script: SHIFT_SCRIPTS[2], interlude: null, nextScript: null },
];

// Plain weather words for the day bar.
const WEATHER_NAMES = { clear: 'Clear', fog: 'Fog', blow: 'A blow', storm: 'Storm' };

// The two storm-night narration lines (ui-spec, verbatim).
const GUTTER_LINE = 'Near four the lamp guttered. Some minutes passed before she burned again. No one else saw.';
const HELD_LINE = 'The lamp held all night. You know why.';

// The run-id localStorage key (QA-2026-07-24 AT-2). A UI-owned key, distinct
// from the engine's SAVE_KEY/ARCHIVE_KEY — see the runId lifecycle notes in
// createGame for why the id cannot live in the engine state.
const RUN_ID_KEY = 'keepers-log/run-id';

// ── Module-level pure helpers (no DOM, no closures over live state) ──────────
// Extracted (QA-2026-07-24 TA-1 batch) so tests pin these copies of engine-
// adjacent rules directly — a silent revert of any of them would otherwise pass
// every existing test, since they are UI code the engine cannot see.

/** setSystem — override one system aspect immutably. */
function setSystem(s, system, aspect, value) {
	return { ...s, systems: { ...s.systems, [system]: { ...s.systems[system], [aspect]: value } } };
}

/** setFlag — set one flag immutably. */
function setFlag(s, key, value) {
	return { ...s, flags: { ...s.flags, [key]: value } };
}

/**
 * recordDutyDone — mark a P4c station action done for the day, deduped.
 * The storm's gutter check reads flags.dutiesDone for 'pumpFuel', so pumping
 *   must land there exactly as an engine duty would.
 */
function recordDutyDone(s, kind) {
	const done = s.flags.dutiesDone ?? [];
	if (done.includes(kind)) return s;
	return { ...s, flags: { ...s.flags, dutiesDone: [...done, kind] } };
}

/**
 * stationActionCore — the PURE core of the four P4c scene actions (ui-spec) that
 * do more than a plain engine duty: they patch systems/flags, which engine.duty()
 * does not, and the engine's tu-spend guard is not exported — so this composite
 * guards affordability itself (mirroring engine.spend) and applies the cost and
 * the effect together. Receives (state, id); returns an ActionResult-shaped
 * object PLUS an `addJournal` flag: opening the cellar reveals a book page, which
 * is a VIEW effect the caller performs (keeping this function pure and testable —
 * QA-2026-07-24 TA-1 batch). Throws on an unknown id (a programming error).
 */
export function stationActionCore(state, id) {
	const spec = STATION_ACTIONS[id];
	if (!spec) throw new Error(`stationAction: unknown action "${id}"`);
	if (spec.cost > state.tu) {
		return { ok: false, state, reason: `insufficient tu (need ${spec.cost}, have ${state.tu})` };
	}
	let next = spec.cost > 0 ? { ...state, tu: state.tu - spec.cost } : state;
	let addJournal = false;
	if (id === 'pumpFuel') {
		next = recordDutyDone(next, 'pumpFuel');
	} else if (id === 'rodFlue') {
		next = recordDutyDone(next, 'rodFlue');
		next = setSystem(next, 'structure', 'flue', 'rodded-through');
		next = setSystem(next, 'structure', 'flueFixed', true);
		// DOING is OBSERVING: an afternoon inside that chimney with the rods is
		// more intimate knowledge of the flue than any inspection — the
		// witnessed-observation principle applied to work performed. Without this,
		// the desk told a keeper who had just rodded the flue through "(you never
		// looked)" — caught live in the 2026-07-24 playtest.
		next = appendObservation(next, {
			factId: factKey(CLAIMS['P-s2-flue'].subject),
			room: 'quarters', day: next.day, viaVerify: true,
		});
	} else if (id === 'takeRods') {
		next = setFlag(next, 'hasRods', true);
	} else if (id === 'takeCrowbar') {
		next = setFlag(next, 'hasCrowbar', true);
	} else if (id === 'openCellar') {
		next = setFlag(next, 'cellarOpened', true);
		addJournal = true; // the caller adds the Callum journal page (a view effect)
	}
	return { ok: true, state: next, addJournal };
}

/**
 * handForEntry — the typographic hand a saved/archived entry is drawn in, from
 * its keeperId alone. The shared hand-resolver (QA-2026-07-24 CR-2) used by BOTH
 * rebuildBook (this run's live pages) and appendInheritedPages (prior runs).
 * Before this, appendInheritedPages hardcoded 'player' for EVERY inherited
 * entry — so an archived run's NPC entries (Pearse/Reed) rendered in the player
 * hand, which draws a signature line; the result was a raw "— pearse" ON TOP OF
 * the NPC template's own inline sign-off, doubled. NPC hands draw no signature
 * line (pages.js gates the signature on hand === 'player'), so resolving the
 * hand per entry from the keeperId fixes both symptoms.
 */
export function handForEntry(entry) {
	if (entry.keeperId === 'pearse') return 'pearse';
	if (entry.keeperId === 'reed') return 'reed';
	return 'player'; // keeper-N (and any unexpected id) render in the player's hand
}

/**
 * tailorInterlude — drop interlude items whose triggering EVENT never happened
 * this run. The engine's variant selection reads only claim tags, so an item for
 * an event that never occurred would fire its 'ambush' branch on mere silence —
 * the 2026-07-24 playtest caught Pearse answering an Ilsa query about a dark
 * light on a run where the lamp HELD all night. The beat layer owns events
 * (ui-spec), so the beat layer filters: the gutter item exists only when the lamp
 * actually guttered. Content is never mutated — this builds a shallow copy with a
 * filtered loadBearing. Pure (state passed explicitly) so a test pins it
 * (QA-2026-07-24 TA-1 batch).
 */
export function tailorInterlude(interlude, state) {
	const loadBearing = interlude.loadBearing.filter((item) => {
		if (item.claimHook === 'P-s1-gutter') return state.systems?.light?.stormNightLapse === 'guttered';
		return true;
	});
	return { ...interlude, loadBearing };
}

/**
 * actionsLatched — is player input refused right now?
 * Receives the two latch flags; returns true while an overlay is open OR once the
 *   finale has become terminal. Exported pure (QA-2026-07-24 CR-1/AT-1/A11Y-4) so
 *   the latch invariant is pinned without a DOM: the state model is the authority;
 *   `inert` on the background is only the barrier laid on top of it. Every player
 *   action and turnIn refuse against this.
 */
export function actionsLatched({ overlayOpen, finaleTerminal }) {
	return overlayOpen === true || finaleTerminal === true;
}

/**
 * deskOpeningLatched — is opening a NIGHT's desk refused?
 * Receives the finaleTerminal flag; returns true once the finale is terminal.
 *   openDeskForNight runs from INSIDE an already-open overlay (the sleep choice),
 *   so it must gate on finaleTerminal ONLY — gating it on overlayOpen would refuse
 *   the very desk it exists to open. This is the "everything refuses after the
 *   epilogue, forever" half of the latch, applied to the one path overlayOpen
 *   cannot cover.
 */
export function deskOpeningLatched({ finaleTerminal }) {
	return finaleTerminal === true;
}

/**
 * localStorageAdapter — the obvious {getItem,setItem,removeItem} wrapper the
 * engine's persist layer expects, over window.localStorage.
 * Reads are guarded to return null rather than throw (a blocked/private-mode
 *   store must degrade to "no save," never crash the boot — ui-spec: "never
 *   crash"). Writes are left to throw so saveRun's own quota guard catches them.
 */
function localStorageAdapter() {
	return {
		getItem(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
		setItem(key, value) { window.localStorage.setItem(key, value); },
		removeItem(key) { try { window.localStorage.removeItem(key); } catch { /* nothing to undo */ } },
	};
}

/**
 * createGame — wire the session controller to the views and boot it.
 * Receives:
 *   - book: the createBook controller (needs show + appendPage).
 *   - scene: the mountScene api (setWeather/setLamp/setFlue/setKeeper).
 *   - els: { page, daybar, actions, desk, station, pagenav } DOM elements.
 * Returns { boot } — main.js calls boot() after the book and scene mount.
 * All flow state is closed over here (single owner); nothing leaks to globals.
 */
export function createGame({ book, scene, els }) {
	const storage = localStorageAdapter();
	const pages = createPages({ book });
	const desk = createDesk({ mountEl: els.desk });
	const finale = createFinale({ mountEl: els.desk, scene, storage });
	// Engine action deps: content the pure engine must be handed, never import.
	const deps = { economy: ECONOMY, claims: CLAIMS };

	// ── Flow state (the single source of truth at runtime) ───────────────────
	let state = null;       // the current GameState
	let shiftIdx = 0;       // which of the three SHIFTS
	let dayIdx = 0;         // which day within that shift's day scripts
	let dayStartTU = 12;    // the day's full budget, for "N of M remaining"
	let signature = '';     // the mark chosen for THIS shift (persists the shift)
	let signatureCaptured = false; // has the shift's first desk been signed?
	let started = false;    // guards double-starts from a double cover click
	let overlayOpen = false;   // an overlay is up: actions + turnIn refuse (CR-1 latch)
	let finaleTerminal = false; // the epilogue rendered: everything refuses, forever
	let runId = null;          // this run's stable archive id (AT-2; see below)
	let overlayReturnFocus = null; // element focused before an overlay chain opened

	// The background regions made `inert` while any overlay is up (CR-1/A11Y-4).
	// NEVER #bookwrap or #room — those are ancestors of #desk and would disable
	// the overlay itself. #station is the whole left column (drawing, day bar,
	// actions); #page is the book text, focusable since A11Y-3 gave it
	// tabindex="0", so it must go inert too or Tab would land behind the overlay;
	// #pagenav is the book's page-turn controls. Together they are the entire
	// background, so neither a click nor a Tab reaches anything behind the overlay.
	const inertRegions = [els.station, els.page, els.pagenav].filter(Boolean);

	const actions = createActions({ mountEl: els.actions, handlers: makeHandlers() });

	// ── Small state helpers ──────────────────────────────────────────────────

	/** currentDay — the active day script. */
	function currentDay() { return SHIFTS[shiftIdx].days[dayIdx]; }

	/** entryDateLabel — the term + day label the desk header and entry show. */
	function entryDateLabel() { return `${SHIFTS[shiftIdx].script.dateLabel} · day ${state.day}`; }

	/**
	 * recordObservation — mark a fact as WITNESSED this shift (no tu cost).
	 * Receives a Subject; appends an observation for its factKey through the
	 *   engine's capped helper. Used for facts the keeper lives through rather
	 *   than deliberately inspects — the storm gutter and the storm slate damage.
	 *   Without it the honest, precise report about the gutter would be gated out
	 *   ("you never looked") even though the keeper stood the watch it happened
	 *   on — which would make the shift's moral choice uncomposable.
	 */
	function recordObservation(subject) {
		state = appendObservation(state, { factId: factKey(subject), room: subject.room, day: state.day, viaVerify: false });
	}

	// ── The run id: stable across a refresh, for the archive's idempotency ────

	/**
	 * runId lifecycle (QA-2026-07-24 AT-2). The epilogue archives THIS run under
	 * runId, and archiveEntries dedups by it — so a refresh mid-epilogue then a
	 * resume must re-enter with the SAME id, or the run double-archives.
	 * Homes ruled out, verified against the engine (which is READ-ONLY):
	 *   - state.flags.runId — advanceShift sets flags:{} at EVERY keeper boundary,
	 *     so an id minted in shift 1 is gone long before the shift-3 epilogue.
	 *   - a top-level state field — createState copies only its enumerated fields,
	 *     so an extra field is dropped on the save→load round trip (resume loses it).
	 * The engine-untouched home is a dedicated localStorage key, written at
	 * startFresh, recovered on resume, cleared at onClose. (The QA doc's literal
	 * "state.flags.runId" is unworkable for the flag-clearing reason above; this
	 * is the team-lead-directed fallback.)
	 */
	function mintRunId() {
		runId = `run-${new Date().toISOString()}`; // full ISO precision — same-day replays never collide
		try { storage.setItem(RUN_ID_KEY, runId); } catch (e) { console.warn('keepers-log: run-id save failed —', e.message); }
	}
	function recoverRunId() {
		runId = storage.getItem(RUN_ID_KEY); // getItem is guarded → null on failure
		if (!runId) mintRunId(); // resuming a save from before AT-2: mint one so this session's epilogue is at least stable
	}
	function clearRunId() {
		try { storage.removeItem(RUN_ID_KEY); } catch { /* nothing to undo */ }
	}

	// ── The overlay lifecycle: ONE choke point (CR-1 = AT-1 + A11Y-4) ─────────

	/** latchState — the two latch flags as an object for the pure guards. */
	function latchState() { return { overlayOpen, finaleTerminal }; }

	/** latchedRefusal — the ActionResult an action returns while latched (its
	 *   reason never surfaces — the panel is inert — but the shape keeps callers
	 *   uniform and lets a test assert the refusal without a DOM). */
	function latchedRefusal() { return { ok: false, state, reason: 'not now — the desk is open' }; }

	/**
	 * setBackgroundInert — toggle the `inert` attribute on every background
	 *   region. `inert` removes the subtree from the tab order, the hit-test, and
	 *   the accessibility tree in one property — the DOM barrier CR-1 wanted.
	 */
	function setBackgroundInert(on) {
		for (const el of inertRegions) {
			if (on) el.setAttribute('inert', '');
			else el.removeAttribute('inert');
		}
	}

	/**
	 * openOverlay — the single entry point that makes any book-side overlay live.
	 * Receives renderContent(): a callback that fills #desk with the overlay's
	 *   markup (the caller renders; openOverlay owns the lifecycle around it). On
	 *   call it remembers the currently-focused element (to restore on close — but
	 *   only at the START of an overlay chain, so a chained step like bookFate→
	 *   epilogue does not overwrite it with a button about to be destroyed), sets
	 *   the overlayOpen latch, makes the background inert, reveals #desk, runs
	 *   renderContent, then moves focus to the first control inside the overlay.
	 */
	function openOverlay(renderContent) {
		if (!overlayOpen) overlayReturnFocus = document.activeElement;
		overlayOpen = true;
		setBackgroundInert(true);
		els.desk.hidden = false;
		renderContent();
		focusIntoOverlay();
	}

	/**
	 * closeOverlay — the single exit point. Clears the overlayOpen latch, hides
	 *   #desk, lifts the inert barrier, and returns focus to where it was (or a
	 *   safe landing if that element is gone). Does NOT touch finaleTerminal — the
	 *   finale never closes back to play; onClose reloads instead.
	 */
	function closeOverlay() {
		overlayOpen = false;
		els.desk.hidden = true;
		setBackgroundInert(false);
		restoreFocus();
	}

	/**
	 * focusIntoOverlay — move focus to the overlay's first focusable control, or
	 *   the overlay container itself (it carries tabindex="-1") when a rare overlay
	 *   has none. Runs after renderContent, so the target exists.
	 */
	function focusIntoOverlay() {
		const focusable = els.desk.querySelector(
			'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
		);
		(focusable ?? els.desk).focus();
	}

	/**
	 * restoreFocus — return focus to the pre-overlay element if it is still in the
	 *   document; otherwise land on #page (the keyboard-scrollable book region),
	 *   which always exists. Most of our overlays advance state and destroy their
	 *   trigger (the "Turn in" button is re-rendered away), so #page is the common
	 *   landing — reachable, never stranded on a detached node.
	 */
	function restoreFocus() {
		const target = (overlayReturnFocus && overlayReturnFocus.isConnected) ? overlayReturnFocus : els.page;
		overlayReturnFocus = null;
		if (target && typeof target.focus === 'function') target.focus();
	}

	// ── The action handlers handed to actions.js ─────────────────────────────

	/**
	 * makeHandlers — the intent callbacks the action panel invokes. Each engine
	 *   action returns an ActionResult; run() commits it on success and returns it
	 *   so the panel can show a refusal's reason. Every engine-backed handler is
	 *   wrapped in guardAction so it refuses while an overlay is open or the finale
	 *   is terminal — the state latch beneath the inert DOM barrier (CR-1).
	 */
	function makeHandlers() {
		return {
			move: guardAction((to, deliberate) => run(move(state, to, deps, { deliberate }))),
			duty: guardAction((kind) => run(duty(state, kind, deps))),
			station: guardAction(stationHandler),
			follow: guardAction((claimId) => run(followClaim(state, claimId, deps))),
			inspect: guardAction((claimId) => run(inspect(state, { claimId }, deps))),
			read: guardAction((stratum) => runRead(stratum)),
			turnIn,
		};
	}

	/**
	 * guardAction — wrap a handler so it refuses (returns latchedRefusal) while
	 *   actionsLatched is true, otherwise runs the handler. The refusal is belt to
	 *   inert's braces: the panel is inert so the click can't happen, but the latch
	 *   is the authoritative model-level invariant AT-1's re-archive exploit needs.
	 */
	function guardAction(fn) {
		return (...args) => (actionsLatched(latchState()) ? latchedRefusal() : fn(...args));
	}

	/** run — commit an ActionResult on success (sync views), then return it. */
	function run(result) {
		if (result.ok) { state = result.state; syncScene(); refresh(); }
		return result;
	}

	/** runRead — readLog, plus open the read stratum's page in the book. */
	function runRead(stratum) {
		const result = readLog(state, stratum, deps);
		if (result.ok) {
			state = result.state;
			book.show(1 + STRATA.indexOf(stratum)); // pages = [cover, ...STRATA, ...live]
			syncScene();
			refresh();
		}
		return result;
	}

	/**
	 * stationHandler — apply a station action's PURE core (stationActionCore),
	 *   then perform its one view effect (the cellar journal page) and commit.
	 *   Splitting the pure core from the view effect keeps the core testable and
	 *   keeps the page-append (which the book, not the state, owns) here.
	 */
	function stationHandler(id) {
		const result = stationActionCore(state, id);
		if (result.ok && result.addJournal) pages.addJournalPage(CALLUM_JOURNAL);
		return run(result);
	}

	// ── Scene + chrome sync ──────────────────────────────────────────────────

	/**
	 * syncScene — drive the living cutaway from the current state (ui-spec
	 * "Scene driving"). Lamp is lit here always; the ONE exception (the drained
	 *   warmth during a guttered storm-night desk) is set directly at desk-open
	 *   and restored on signing, because no action runs while the desk is up.
	 */
	function syncScene() {
		scene.setKeeper(state.room);
		scene.setWeather(state.weather);
		scene.setFlue(state.systems?.structure?.flueFixed ? 'clear' : 'half');
		scene.setLamp(true);
	}

	/** renderDaybar — term, day, weather, and the hour marks left (diegetic). */
	function renderDaybar() {
		const weather = WEATHER_NAMES[state.weather] ?? state.weather;
		els.daybar.textContent =
			`${SHIFTS[shiftIdx].script.dateLabel} · Day ${state.day} · ${weather} · Hour marks: ${state.tu} of ${dayStartTU} remaining`;
	}

	/** refresh — repaint the action panel and the day bar for the current room. */
	function refresh() {
		actions.render(state, currentDay());
		renderDaybar();
	}

	// ── The day loop ─────────────────────────────────────────────────────────

	/**
	 * applyDayStartEvents — the scripted world changes that fire at a day's dawn.
	 * Today only the S1 storm (day 3): iterate S1_STORM_DELTAS and apply every
	 * delta EXCEPT light.stormNightLapse, which is decided at THAT night's desk
	 * from whether the player pumped (openDeskForNight sets it). The keeper
	 * witnesses the storm's damage, so the slate fact is recorded as observed —
	 * enabling a precise slate instruction later. The top guard makes this
	 * idempotent (a resume lands on an already-stormed state; re-applying would
	 * duplicate the slate observation).
	 * (Author note: slate observation is tied to living through the storm, the
	 * same principle as the gutter; if a dedicated day-4 "survey the damage"
	 * action is preferred, that is a P4e content decision.)
	 */
	function applyDayStartEvents() {
		if (currentDay().id !== 's1-d3') return;
		if (state.systems?.structure?.slates === S1_STORM_DELTAS.structure.slates) return; // already applied
		for (const [system, aspects] of Object.entries(S1_STORM_DELTAS)) {
			for (const [aspect, value] of Object.entries(aspects)) {
				if (system === 'light' && aspect === 'stormNightLapse') continue; // decided that night at the desk
				state = setSystem(state, system, aspect, value);
			}
		}
		recordObservation(CLAIMS['P-s1-slates'].subject);
	}

	/**
	 * beginDay — enter the current day: fire its dawn events, capture the full
	 * budget for the day bar, reveal the chrome, sync the scene, paint, and save.
	 * Saving here (a clean day-start snapshot with full tu) is the ui-spec's
	 *   "save after every desk" made a stable resume point — a resume always
	 *   lands the player at a day's dawn, never mid-day.
	 */
	function beginDay() {
		applyDayStartEvents();
		dayStartTU = state.tu;
		els.daybar.hidden = false;
		syncScene();
		refresh();
		persist();
		maybeShowFitter();
	}

	/**
	 * maybeShowFitter — shift-3 day-1 only, once per run: show the fitter's
	 * arrival notice in the desk overlay BEFORE the action panel is usable. The
	 * panel is cleared while the notice is up and restored (refresh) on "Return
	 * to the day," so the player reads the decommission news before acting.
	 * "Once per run" is a state flag (survives resume and the day-2 roll).
	 * Called from beginDay AND resumeGame so a resume INTO s3-d1 still shows it.
	 */
	function maybeShowFitter() {
		if (currentDay().id !== 's3-d1' || state.flags.fitterShown) return;
		state = setFlag(state, 'fitterShown', true);
		persist();
		els.actions.innerHTML = ''; // hold the day until the notice is dismissed
		openOverlay(() => finale.fitterNotice(() => { closeOverlay(); refresh(); }));
	}

	/** persist — save the run; a quota/blocked failure never crashes the game. */
	function persist() {
		const result = saveRun(storage, state);
		if (!result.ok) console.warn('keepers-log: save failed —', result.error);
	}

	// ── Turning in: sleep choice → storm event → the desk ────────────────────

	/** turnIn — open the sleep-location choice in the overlay. Refuses while an
	 *   overlay is already up or the finale is terminal (the CR-1 latch). */
	function turnIn() {
		if (actionsLatched(latchState())) return;
		openOverlay(() => {
			els.desk.innerHTML = `
				<div class="desk-inner interstitial">
					<p class="interstitial-line">The light is dressed for the night. Where do you bed down?</p>
					<div class="interstitial-actions">
						<button id="sleep-quarters" type="button">Your bed in the quarters</button>
						<button id="sleep-watch" type="button">The watch-room chair</button>
					</div>
				</div>`;
			els.desk.querySelector('#sleep-quarters').addEventListener('click', () => chooseSleep('quarters'));
			els.desk.querySelector('#sleep-watch').addEventListener('click', () => chooseSleep('watch'));
		});
	}

	/** chooseSleep — record the sleep location, then open the night's desk. */
	function chooseSleep(location) {
		state = sleep(state, location, deps).state; // sleep never refuses
		openDeskForNight();
	}

	/**
	 * openDeskForNight — resolve the storm-night event (if this is that night),
	 * then hand the desk its context. The gutter/held decision reads whether the
	 * player pumped that day; it sets the truth stormNightLapse against which the
	 * desk's honest/lie options will be tagged. Runs from inside the sleep-choice
	 * overlay, so it re-renders the same overlay (openOverlay keeps the chain's
	 * return-focus) and gates on finaleTerminal only (deskOpeningLatched).
	 */
	function openDeskForNight() {
		if (deskOpeningLatched(latchState())) return; // never re-open a desk after the finale
		const day = currentDay();
		if (day.id === 's3-d2') { openLastDesk(); return; } // the finale replaces the desk
		let eventLine = null;
		if (day.id === 's1-d3') {
			const pumped = (state.flags.dutiesDone ?? []).includes('pumpFuel');
			state = setSystem(state, 'light', 'stormNightLapse', pumped ? 'held' : 'guttered');
			eventLine = pumped ? HELD_LINE : GUTTER_LINE;
			// TA-1-gutter (QA-2026-07-24): witness the gutter ONLY when it happened.
			// On a held night nothing guttered, so recording an observation would
			// let composeEntry accept a PRECISE lie about a phantom gutter if the
			// desk's subjectVisible gate were ever bypassed. Gating the observation
			// on !pumped makes the engine's compose gate the backstop; subjectVisible
			// demotes to defense-in-depth. No consumer needs the observation on a
			// held night (verified by AT).
			if (!pumped) {
				recordObservation(CLAIMS['P-s1-gutter'].subject); // the keeper stood the watch it happened on
				scene.setLamp(false); // the warmth goes out while they choose what to write
			}
		}
		openOverlay(() => desk.open({
			state,
			statementSet: SHIFTS[shiftIdx].statementSet,
			dateLabel: entryDateLabel(),
			eventLine,
			needsSignature: !signatureCaptured,
			signature,
			onSign,
		}));
	}

	/**
	 * onSign — the desk handed back a draft; freeze it into the log and advance.
	 * Assembles the full draft (id/keeperId/dateLabel/layer the desk needn't
	 *   know) and calls composeEntry. composeEntry THROWS on an illegal
	 *   composition; the desk's gates prevent that, so a throw here is a real bug
	 *   and must NOT be caught (ui-spec: "let it throw loudly").
	 */
	function onSign(draft) {
		const fullDraft = {
			id: `keeper-${shiftIdx + 1}-d${state.day}`,
			keeperId: `keeper-${shiftIdx + 1}`,
			dateLabel: entryDateLabel(),
			layer: 'operational',
			signature: draft.signature,
			sentences: draft.sentences,
		};
		if (draft.personalNote != null) fullDraft.personalNote = draft.personalNote;
		state = composeEntry(state, fullDraft, { templates: TEMPLATES, claims: CLAIMS });
		signature = draft.signature;
		signatureCaptured = true;
		pages.addEntry(state.entries[state.entries.length - 1], playerMeta(shiftIdx));
		scene.setLamp(true); // restore the warmth the gutter drained (no-op otherwise)
		closeOverlay();       // the desk is done; lift the barrier before advancing
		afterDesk();
	}

	// ── The finale (shift 3 day 2 → fate → epilogue → cover) ─────────────────

	/** openLastDesk — hand shift-3 day-2's desk to the finale renderer. */
	function openLastDesk() {
		openOverlay(() => finale.lastDesk({ dateLabel: entryDateLabel(), signature, onSign: onSignFinal }));
	}

	/**
	 * onSignFinal — the last entry. draft is the chosen option { statementId,
	 *   text, personalNote?, signature } or null for 'final-unsigned' (no entry
	 *   composed; the empty page stands). The option's full text is frozen as ONE
	 *   vague, claim-less sentence — unparsed testimony, stored verbatim via
	 *   composeEntry's explicit-text path (nothing downstream consumes it). Then
	 *   the book's fate. Chains within the open overlay (no close between steps).
	 */
	function onSignFinal(draft) {
		if (draft) {
			signature = draft.signature;
			const fullDraft = {
				id: `keeper-3-d${state.day}`,
				keeperId: 'keeper-3',
				dateLabel: entryDateLabel(),
				layer: 'operational',
				signature: draft.signature,
				sentences: [{ statementId: draft.statementId, certainty: 'vague', text: draft.text }],
			};
			if (draft.personalNote != null) fullDraft.personalNote = draft.personalNote;
			state = composeEntry(state, fullDraft, { templates: TEMPLATES, claims: CLAIMS });
			pages.addEntry(state.entries[state.entries.length - 1], playerMeta(2));
		}
		openOverlay(() => finale.bookFate(onFate));
	}

	/** onFate — the fate is chosen; the finale becomes terminal and the epilogue
	 *   renders. finaleTerminal set HERE (before the render) so every action and
	 *   turnIn refuse from this moment on, forever (the re-archive exploit AT-1
	 *   found is now impossible at the state level, not just the DOM level). The
	 *   epilogue reads the STABLE runId (AT-2), not a fresh Date. */
	function onFate(fate) {
		finaleTerminal = true;
		openOverlay(() => finale.epilogue({ state, fate, onClose, runId }));
	}

	/**
	 * onClose — the book closes. The run is already archived (the epilogue did
	 * it); clear the in-run save and this run's id (the archive stays) and return
	 * to a pristine cover by reloading. The reload — rather than an in-place
	 * teardown — is what keeps this within the finale-spec's "nothing else" file
	 * constraint (no book/pages reset methods): it drops this run's appended pages
	 * and the live sections wholesale, and boot() then shows the cover with no
	 * resume button (the save is gone). The archive persists, so the next run
	 * inherits this one; the next run mints a fresh runId of its own.
	 */
	function onClose() {
		startNewRun(storage);
		clearRunId();
		window.location.reload();
	}

	// ── Day / shift boundaries ───────────────────────────────────────────────

	/** afterDesk — roll to the next day, or end the shift if it was the last. */
	function afterDesk() {
		const shift = SHIFTS[shiftIdx];
		if (dayIdx < shift.days.length - 1) {
			// The keeper wakes WHERE THEY SLEPT, not where they happened to be
			// standing at turn-in. advanceDay consumes the sleptIn flag, so read
			// it first; both sleep locations are real rooms. (2026-07-24
			// playtest: waking in the lamp room after "sleeping in the quarters"
			// bit twice in one run — dissonant and it warps morning routes.)
			const sleptIn = state.flags.sleptIn;
			state = advanceDay(state, shift.days[dayIdx + 1], deps);
			if (sleptIn) state = { ...state, room: sleptIn };
			dayIdx += 1;
			beginDay();
		} else {
			endOfShift();
		}
	}

	/**
	 * endOfShift — the keeper boundary for shifts 1 and 2: the boat interstitial,
	 * then (on continue) run the interlude — appending the NPC keeper's pages the
	 * next keeper will read — and advance to the next shift. Shift 3 never reaches
	 * here: its last day (s3-d2) is intercepted by openDeskForNight and handed to
	 * the finale, so a shift with no interlude has nothing to do here.
	 */
	function endOfShift() {
		const shift = SHIFTS[shiftIdx];
		if (!shift.interlude) return;
		showShiftInterstitial(shift.nextScript, () => {
			const before = state.entries.length;
			state = runInterlude(state, tailorInterlude(shift.interlude, state), deps);
			for (const entry of state.entries.slice(before)) pages.addEntry(entry, npcMeta(shift.interlude));
			state = advanceShift(state, shift.nextScript, deps);
			shiftIdx += 1;
			dayIdx = 0;
			signature = '';
			signatureCaptured = false;
			closeOverlay(); // close the boat interstitial before the new day (which may re-open for the fitter)
			beginDay();
		});
	}

	/** playerMeta — book-page grouping for a player term's entries. */
	function playerMeta(idx) {
		return { pageKey: `player-${idx}`, title: `${SHIFT_SCRIPTS[idx].dateLabel} · your term`, hand: 'player' };
	}

	/** npcMeta — book-page grouping + hand for an interlude keeper's entries. */
	function npcMeta(interlude) {
		if (interlude.npcKeeperId === 'pearse') return { pageKey: 'npc-pearse', title: `${interlude.dateLabel} · D. Pearse`, hand: 'pearse' };
		return { pageKey: 'npc-reed', title: `${interlude.dateLabel} · S. Reed`, hand: 'reed' };
	}

	/**
	 * showShiftInterstitial — the boat comes; the plain-paper transition to the
	 * next term. Receives the next shift's script and a continue callback. Opens
	 * through the one overlay choke point.
	 */
	function showShiftInterstitial(nextScript, onContinue) {
		openOverlay(() => {
			els.desk.innerHTML = `
				<div class="desk-inner interstitial">
					<p class="interstitial-line">The relief boat comes for you at first light. By the Rule you are taken off before the next keeper lands — you will never meet.</p>
					<p class="interstitial-line term-next">${escapeHtml(nextScript.dateLabel)}</p>
					<p class="interstitial-line">By appointment of the Conservancy of Lights, the keeping of Sorrel Point passes to a new hand. All that hand will know of you is what you wrote.</p>
					<div class="interstitial-actions">
						<button id="interstitial-continue" type="button">Take up the term</button>
					</div>
				</div>`;
			els.desk.querySelector('#interstitial-continue').addEventListener('click', onContinue);
		});
	}

	// ── Boot, start, resume ──────────────────────────────────────────────────

	/** startFresh — begin a brand-new run at shift 1, discarding any old save. */
	function startFresh() {
		if (started) return;
		started = true;
		startNewRun(storage); // clear the in-run slot; the archive is left alone
		mintRunId();          // AT-2: this run's stable archive id, before anything can archive
		appendInheritedPages(); // your past runs join the book BEFORE this run's pages
		const script = SHIFT_SCRIPTS[0];
		state = createState({
			shiftIndex: 0, day: script.day, tu: script.tu,
			weather: script.weather, room: script.room,
			systems: structuredClone(SYSTEMS_INITIAL),
		});
		shiftIdx = 0; dayIdx = 0; signature = ''; signatureCaptured = false;
		beginDay();
	}

	/**
	 * appendInheritedPages — the persistence thesis, made real (design-spec §7):
	 * each prior playthrough's whole record joins the book as one page, after the
	 * founding strata and before this run's live pages. "The log you leave is the
	 * log you'll be given." An unreadable/newer archive renders nothing — the
	 * engine refuses internally, so this never crashes and never clobbers.
	 */
	function appendInheritedPages() {
		const archive = loadArchive(storage);
		if (!archive.ok) return; // 'empty' is ok:true with runs:[]; corrupt/newer are ok:false
		for (const runBlock of archive.runs) {
			// Never inherit the ACTIVE run's own block: a refresh in the narrow
			// window between the epilogue's archive and onClose's save-clear would
			// otherwise resume and show this run's entries as "a keeper before
			// you" (stabilization re-review, 2026-07-24; same window AT-2 closed
			// for the archive line via oldestPriorRunDate's filter).
			if (runBlock.runId === runId) continue;
			const date = runBlock.runId.replace(/^run-/, '').slice(0, 10);
			// One page per prior run: a per-run pageKey groups all its entries onto
			// a single page via the existing addEntry. Each entry's HAND is resolved
			// per entry (CR-2, QA-2026-07-24) via the shared handForEntry — the SAME
			// resolver rebuildBook uses — so an archived run's NPC entries render in
			// the pearse/reed hand (no signature line) rather than the player hand,
			// which would double the sign-off. runId is unique, so no two runs
			// collide, and a same-session replay re-inherits cleanly because onClose
			// reloads to a pristine book (no leftover sections to dedup).
			const title = `A keeper before you · ${date}`;
			const pageKey = `inherited-${runBlock.runId}`;
			for (const entry of runBlock.entries) {
				pages.addEntry(entry, { pageKey, title, hand: handForEntry(entry) });
			}
		}
	}

	/**
	 * resumeGame — restore a saved run: rebuild the book's live pages from the
	 * saved entries, recover the shift/day position and the shift's signature,
	 * and drop the player at the saved day's dawn. Best-effort for P4c: it lands
	 * at a day boundary (saves are day-start snapshots) and cannot recover the
	 * cellar journal into a LATER shift (flags clear at the keeper boundary).
	 */
	function resumeGame() {
		if (started) return;
		const result = loadRun(storage);
		if (!result.ok) { startFresh(); return; } // button only shows on ok, but be safe
		started = true;
		recoverRunId(); // AT-2: re-use this run's archive id across the refresh/resume
		state = result.state;
		shiftIdx = Math.min(state.shiftIndex, SHIFTS.length - 1);
		const foundDay = SHIFTS[shiftIdx].days.findIndex((d) => d.day === state.day);
		dayIdx = foundDay === -1 ? 0 : foundDay;
		appendInheritedPages(); // prior completed runs sit before this run's pages
		rebuildBook();
		recoverSignature();
		dayStartTU = state.tu;
		els.daybar.hidden = false;
		syncScene();
		refresh();
		// CR-3 (QA-2026-07-24): leave the cover. The game has started, so the
		// cover's begin/resume buttons are dead and focus would be stranded on the
		// resume button the player just pressed. Turn to the first content page and
		// move focus onto it (the keyboard-scrollable region) — the same
		// don't-strand-focus discipline openOverlay follows.
		book.show(1);
		els.page.focus();
		maybeShowFitter(); // a resume INTO s3-d1 still owes the fitter notice (it re-opens the overlay + refocuses)
	}

	/** rebuildBook — replay saved entries into the book's live pages, in order. */
	function rebuildBook() {
		for (const entry of state.entries) pages.addEntry(entry, metaForEntry(entry));
		if (state.flags.cellarOpened) pages.addJournalPage(CALLUM_JOURNAL);
	}

	/**
	 * metaForEntry — book-page grouping for a saved entry, from its keeperId. The
	 * hand it carries matches the shared handForEntry (npcMeta/playerMeta assign
	 * the same pearse/reed/player values), so live and inherited pages never
	 * disagree about a keeper's hand.
	 */
	function metaForEntry(entry) {
		if (entry.keeperId === 'pearse') return npcMeta(PEARSE_INTERLUDE);
		if (entry.keeperId === 'reed') return npcMeta(REED_INTERLUDE);
		const m = /^keeper-(\d+)$/.exec(entry.keeperId);
		return playerMeta(m ? Number(m[1]) - 1 : 0);
	}

	/** recoverSignature — the current shift's mark lives in its last player entry. */
	function recoverSignature() {
		const mine = `keeper-${shiftIdx + 1}`;
		for (let i = state.entries.length - 1; i >= 0; i--) {
			if (state.entries[i].keeperId === mine) {
				signature = state.entries[i].signature;
				signatureCaptured = true;
				return;
			}
		}
		signature = ''; signatureCaptured = false;
	}

	/**
	 * boot — wire the cover buttons and, if a save exists, offer to resume.
	 * The book already handles #begin (turn to page 1); we ADD the game start on
	 *   the same click and handle the injected #resume button. One delegated
	 *   listener on #page serves both for the life of the page.
	 */
	function boot() {
		els.page.addEventListener('click', (ev) => {
			if (ev.target.closest('#begin')) { startFresh(); return; }
			if (ev.target.closest('#resume')) { resumeGame(); }
		});
		if (loadRun(storage).ok) injectResumeButton();
	}

	/** injectResumeButton — add "Resume the term" to the cover when a save exists. */
	function injectResumeButton() {
		const cover = els.page.querySelector('.cover');
		if (!cover || cover.querySelector('#resume')) return;
		const button = document.createElement('button');
		button.id = 'resume';
		button.type = 'button';
		button.className = 'begin';
		button.textContent = 'Resume the term';
		cover.appendChild(button);
	}

	return { boot };
}
