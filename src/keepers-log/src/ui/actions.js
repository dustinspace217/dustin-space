// actions.js — the action panel under the drawing: what the keeper can do in
// the room they stand in, in the fixed order the ui-spec pins (moves, duties,
// claim actions, read-the-log, then turn in).
//
// View layer: this renders buttons and reports the player's intent back to
// game.js through injected handlers; it never touches engine state itself. The
// engine calls (move/duty/inspect/followClaim/readLog) live in game.js, which
// owns the state — this module only decides WHAT to offer here and HOW to say
// it. Source-explicitness (design-spec §3) is a phrasing job, which is why the
// diegetic CLAIM_LABELS live here, next to the buttons that wear them.

import { neighbors, walkCost } from '../engine/spatial.js';
import { CLAIMS } from '../content/claims.js';
import { ECONOMY } from '../content/economy.js';
import { STRATA } from '../content/founding-log.js';
import { escapeHtml } from './book.js';

// Plain room names for move buttons ("Cross to the siren house — 2h").
const ROOM_NAMES = {
	gallery: 'the gallery', lamp: 'the lamp room', watch: 'the watch room',
	base: 'the tower base', cottage: 'the cottage', quarters: 'the quarters',
	store: 'the stores', workshop: 'the workshop', cellar: 'the cellar',
	siren: 'the siren house', boathouse: 'the boathouse',
};

// Which mandatory duties can be done in which room, and their plain labels.
// The hour cost is read from ECONOMY.duty at label time so the number never
// drifts from the engine's cost. soundSiren is special-cased below (fog only).
const ROOM_DUTIES = {
	watch: ['wind'],
	lamp: ['light', 'douse'],
	cottage: ['meal'],
	siren: ['soundSiren'],
};
const DUTY_LABELS = {
	wind: 'Wind the weights',
	light: 'Light the lamp',
	douse: 'Douse the lamp',
	meal: 'Take a meal',
	soundSiren: 'Sound the siren',
};

// ── The P4c station actions (not in the base ECONOMY.duty table) ─────────────
// These are the four scene actions the ui-spec introduces at P4c: pump fuel,
// rod the flue, take the two workshop tools, and draw the cellar nails. Their
// LABELS + COSTS + GATING live here (co-located with the buttons); game.js
// imports STATION_ACTIONS to APPLY the cost and the effect. Splitting it that
// way keeps one source for each action's cost and one for its consequence.
//
// pumpFuel's cost was the one spec gap the builder flagged; the author ruled
// and it now lives in ECONOMY.duty.pumpFuel (content, single source) — read
// from there like every other duty cost, never copied.
export const STATION_ACTIONS = {
	takeRods: {
		room: 'workshop', cost: 0, hideWhenFlag: 'hasRods',
		label: () => 'Take the long rods from behind the workshop door — free',
	},
	takeCrowbar: {
		room: 'workshop', cost: 0, hideWhenFlag: 'hasCrowbar',
		label: () => 'Take the crowbar from the workshop bench — free',
	},
	pumpFuel: {
		room: 'base', cost: ECONOMY.duty.pumpFuel,
		label: (c) => `Pump fuel up to the header tank — ${c}h`,
	},
	rodFlue: {
		// Cost = A-2.actionCost (the flue job), read from the registry so it
		// tracks the content, not a copy of the number.
		room: 'quarters', cost: CLAIMS['A-2'].actionCost,
		requiresFlag: 'hasRods', requiresFlueUnfixed: true,
		label: (c) => `Rod the quarters’ flue through — ${c}h`,
	},
	openCellar: {
		room: 'base', cost: 2,
		requiresFlag: 'hasCrowbar', requiresFlagUnset: 'cellarOpened',
		label: (c) => `Draw the nails from the cellar door — ${c}h`,
	},
};

// Short stratum labels for the read-the-log buttons. (book.js keeps its own
// full era titles for the page headers; these are the terse action-button
// forms — presentation, so a local copy is correct, not drift.)
const STRATUM_TITLES = {
	'pair-era': 'the two-hands years',
	'trouble': 'the wreck winter',
	'rule-early': 'the early Arrangement',
	'rule-middle': 'the middle years',
	'rule-late': 'the recent hands',
};

// ── The diegetic claim labels (ui-spec: "ship in a small CLAIM_LABELS map") ──
// Source-explicit phrasing (design-spec §3): "Follow X" always leans on
// testimony; "Inspect X first" always spends time on ground truth. Written
// plainly from each claim's content; the author polishes the wording. Only
// inherited-log claims appear as live claim-actions (player P-* claims are desk
// statements, never live), so only they need labels.
const CLAIM_LABELS = {
	'V-1': { follow: 'Follow Voss’s remedy — strike the valve, then open the cock', inspect: 'Inspect the siren valve first' },
	'V-2': { follow: 'Follow the chalked correction — add four minutes', inspect: 'Check the clock against the almanac first' },
	'V-3': { follow: 'Take Voss’s weather archive as written', inspect: 'Cross-read the barometer archive first' },
	'B-1': { follow: 'Trust Brand — the Sisters bell walks east', inspect: 'Listen for the bell from the gallery first' },
	'Q-1': { follow: 'Follow the log — a gale sprang the SW panel', inspect: 'Cross-check that gale against the glass first' },
	'A-1': { follow: 'Heed the old warning about the quarters', inspect: 'Stand the quarters and judge it first' },
	'A-2': { follow: 'Do as the flue note says', inspect: 'Inspect the quarters’ flue first' },
	'O-1': { follow: 'Follow Okafor — the clock is honest, ignore the chalk', inspect: 'Check the clock against the almanac first' },
	'O-2': { follow: 'Follow Okafor’s partial-flue note', inspect: 'Inspect how far the flue was rodded first' },
	'O-3': { follow: 'Take Okafor at her word — behind the tea tin', inspect: 'Look behind the tea tin first' },
	'G-1': { follow: 'Follow Voss — trust the dip-rule over the gauge', inspect: 'Dip the header tank and check the gauge first' },
	'C-1': { follow: 'Trust the last logged stores count', inspect: 'Count the stores at the shelf first' },
};

/**
 * btn — one action button as markup.
 * Receives the data-act value, a map of extra data-* attributes, the visible
 *   label, and an optional {disabled} flag. Returns an HTML string. Centralises
 *   the button shape so every group renders consistently and the delegated
 *   click handler can read intent from data-act uniformly.
 * Exported (QA-2026-07-24 SEC-2/3) so a test pins the attribute escaping at the
 *   helper — a revert that drops the escapeHtml calls fails against a value
 *   carrying a `"`.
 */
export function btn(act, data, label, { disabled = false } = {}) {
	// QA-2026-07-24 (SEC-2/3): the act and every data-* key/value land in an
	// attribute UNESCAPED. All of them are authored today (room ids, claim ids,
	// duty kinds, 'true'/'false'), but escaping ENFORCES that authored-only
	// assumption rather than trusting it to keep holding — the same shape as the
	// comment-said-authored-only-then-the-bug-shipped class SEC named. The label
	// is passed raw on purpose: callers hand it already-safe text (authored
	// room/claim labels and numbers), never player-controlled input.
	const attrs = Object.entries(data)
		.map(([k, v]) => `data-${escapeHtml(k)}="${escapeHtml(v)}"`)
		.join(' ');
	return `<button type="button" data-act="${escapeHtml(act)}" ${attrs}${disabled ? ' disabled' : ''}>${label}</button>`;
}

/**
 * moveButtons — one button per adjacent room, storm legs handled per ui-spec.
 * Receives the state. Returns HTML. A leg blocked by a storm renders a DISABLED
 *   "storm-barred" button plus a second "…risk it in the storm" button that
 *   passes deliberate:true (the only way through — engine walkCost gates it).
 *   Open legs render one plain button with the hour cost.
 */
export function moveButtons(state) {
	// CR-6 (QA-2026-07-24): the cellar door is nailed shut until the player draws
	// the nails (the openCellar station action sets flags.cellarOpened). The nailed
	// door IS a wall, so the move to the cellar is not offered at all until then —
	// before this filter, "Cross to the cellar" appeared from the tower base on day
	// one, offering a passage that did not yet exist. Exported so a test pins the
	// gate against this assembled string (a revert re-adds the phantom door).
	return neighbors(state.room)
		.filter((to) => to !== 'cellar' || state.flags.cellarOpened)
		.map((to) => {
			const { cost, blocked } = walkCost(state.room, to, state.weather, false);
			const name = ROOM_NAMES[to] ?? to;
			if (blocked) {
				return btn('move', { to, deliberate: 'false' }, `Cross to ${name} — storm-barred`, { disabled: true })
					+ btn('move', { to, deliberate: 'true' }, `…risk it in the storm — ${cost}h`);
			}
			return btn('move', { to, deliberate: 'false' }, `Cross to ${name} — ${cost}h`);
		}).join('');
}

/**
 * dutyButtons — the mandatory duties + P4c station actions available here.
 * Receives the state. Returns HTML. Regular duties come from ROOM_DUTIES (with
 *   soundSiren gated to fog); station actions come from STATION_ACTIONS filtered
 *   by their room + flag gates. Both label their hour cost so the player sees
 *   the price before spending it.
 */
function dutyButtons(state) {
	const parts = [];
	for (const kind of ROOM_DUTIES[state.room] ?? []) {
		if (kind === 'soundSiren' && state.weather !== 'fog') continue;
		parts.push(btn('duty', { kind }, `${DUTY_LABELS[kind]} — ${ECONOMY.duty[kind]}h`));
	}
	for (const [id, spec] of Object.entries(STATION_ACTIONS)) {
		if (spec.room !== state.room) continue;
		if (spec.hideWhenFlag && state.flags[spec.hideWhenFlag]) continue;
		if (spec.requiresFlag && !state.flags[spec.requiresFlag]) continue;
		if (spec.requiresFlagUnset && state.flags[spec.requiresFlagUnset]) continue;
		if (spec.requiresFlueUnfixed && state.systems?.structure?.flueFixed) continue;
		parts.push(btn('station', { id }, spec.label(spec.cost)));
	}
	return parts.join('');
}

/**
 * claimButtons — the source-explicit pair for each live claim rooted here.
 * Receives the state and the current day script. Returns HTML. A claim is
 *   offered when it is live TODAY (day.liveClaims) AND its verifyRoom or its
 *   subject's room is the current room (ui-spec rule 3). Each yields "Follow …"
 *   (act on testimony) and "Inspect … first — Nh" (spend time on ground truth);
 *   an already-verified claim's inspect button is disabled and marked, so the
 *   player can't pay twice and can SEE that they already know.
 */
function claimButtons(state, day) {
	const live = day.liveClaims ?? [];
	const parts = [];
	for (const id of live) {
		const claim = CLAIMS[id];
		const labels = CLAIM_LABELS[id];
		if (!claim || !labels) continue; // player claims / unlabeled: never live actions
		const here = claim.verifyRoom === state.room || claim.subject?.room === state.room;
		if (!here) continue;
		const followCost = claim.actionCost ? ` — ${claim.actionCost}h` : '';
		parts.push(btn('follow', { claim: id }, `${labels.follow}${followCost}`));
		const verified = state.claimsVerified.includes(id);
		if (verified) {
			parts.push(btn('inspect', { claim: id }, `${labels.inspect} — verified`, { disabled: true }));
		} else {
			const cost = claim.verifyCost ?? ECONOMY.inspectCost;
			parts.push(btn('inspect', { claim: id }, `${labels.inspect} — ${cost}h`));
		}
	}
	return parts.join('');
}

/**
 * readButtons — read-the-log, offered only in the watch room.
 * Receives the state. Returns HTML: one button per stratum NOT yet read this
 *   shift (flags.strataRead persists across days within a shift, so a stratum
 *   drops off once read — re-opening it later is free via the page nav). The
 *   ui-spec says "not yet read today"; the engine tracks per-SHIFT reading, so
 *   this is the faithful engine-backed reading of that intent.
 */
function readButtons(state) {
	if (state.room !== 'watch') return '';
	const readAlready = state.flags.strataRead ?? [];
	return STRATA
		.filter((s) => !readAlready.includes(s))
		.map((s) => btn('read', { stratum: s }, `Read the old pages: ${STRATUM_TITLES[s]} — ${ECONOMY.readLog}h`))
		.join('');
}

/**
 * createActions — build the action panel controller.
 * Receives { mountEl, handlers } where handlers are the game's intent callbacks
 *   ({ move, duty, station, follow, inspect, read, turnIn }). Each engine-backed
 *   handler returns the engine ActionResult ({ ok, reason? }); on ok:false the
 *   panel shows the reason in its status line and leaves the buttons as they are
 *   (state unchanged). On ok the game refreshes the panel itself.
 * Returns { render(state, day) } — call it after every state change.
 * One delegated click listener serves all buttons for the panel's whole life,
 *   so re-rendering the innerHTML never orphans a listener.
 */
export function createActions({ mountEl, handlers }) {
	mountEl.addEventListener('click', (ev) => {
		const button = ev.target.closest('button[data-act]');
		if (!button || button.disabled) return;
		const { act } = button.dataset;
		let result;
		if (act === 'move') result = handlers.move(button.dataset.to, button.dataset.deliberate === 'true');
		else if (act === 'duty') result = handlers.duty(button.dataset.kind);
		else if (act === 'station') result = handlers.station(button.dataset.id);
		else if (act === 'follow') result = handlers.follow(button.dataset.claim);
		else if (act === 'inspect') result = handlers.inspect(button.dataset.claim);
		else if (act === 'read') result = handlers.read(button.dataset.stratum);
		else if (act === 'turnin') { handlers.turnIn(); return; }
		// A refused action (ok:false) surfaces its reason here; a successful one
		// triggers a game-side refresh that rebuilds this panel (clearing status).
		if (result && result.ok === false) {
			const status = mountEl.querySelector('.status');
			if (status) status.textContent = result.reason ?? '';
		}
	});

	/**
	 * render — paint the panel for the current room. Receives the state and the
	 *   current day script; groups render in the ui-spec's fixed order, with the
	 *   always-available "Turn in for the night" set apart at the end.
	 */
	function render(state, day) {
		const groups = [
			`<div class="action-group action-moves">${moveButtons(state)}</div>`,
			`<div class="action-group action-duties">${dutyButtons(state)}</div>`,
			`<div class="action-group action-claims">${claimButtons(state, day)}</div>`,
			`<div class="action-group action-read">${readButtons(state)}</div>`,
			`<div class="action-turnin">${btn('turnin', {}, 'Turn in for the night')}</div>`,
			`<p class="status" role="status" aria-live="polite"></p>`,
		];
		mountEl.innerHTML = groups.join('');
	}

	return { render };
}
