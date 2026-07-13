/**
 * tests/gallery-filter.test.js — unit tests for the pure gallery-filter logic
 * extracted to src/assets/js/gallery-filter-logic.js. Run with `npm test`.
 *
 * Issue #118 (Fix Wave 2 W7, Sol ruling 1): the three-axis AND matching, the
 * toggle semantics, the URL parse/validate/restore, and the count math used to
 * live inside gallery.js's DOMContentLoaded handler, unreachable to node:test —
 * only a browser probe could catch a regression. These tests pin the contract
 * the gallery relies on: combined filters, clearing, invalid URL state, counts,
 * and the empty state.
 *
 * The module is UMD, so a plain require() gets the same API the browser sees on
 * window.GalleryFilterLogic.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const FL = require('../src/assets/js/gallery-filter-logic');

// A small, representative card set mirroring the real data model: data-tags
// carries BOTH subject tags and catalog slugs; data-equipment is one slug.
const CARDS = [
	{ tags: ['emission-nebula', 'messier'],       eq: 'personal'   }, // 0
	{ tags: ['galaxy', 'messier'],                 eq: 'personal'   }, // 1
	{ tags: ['galaxy', 'caldwell'],                eq: 'itelescope' }, // 2
	{ tags: ['solar'],                             eq: 'solar'      }, // 3
	{ tags: ['supernova-remnant', 'caldwell'],     eq: 'personal'   }, // 4
];

const ALL = FL.ALL; // "all"
const UNFILTERED = { type: ALL, cat: ALL, eq: ALL };

// ── cardMatches: three-axis AND ──────────────────────────────────────────────
test('cardMatches: unfiltered state matches every card', () => {
	for (const card of CARDS) {
		assert.equal(FL.cardMatches(card.tags, card.eq, UNFILTERED), true);
	}
});

test('cardMatches: single type filter matches on the subject tag', () => {
	const state = { type: 'galaxy', cat: ALL, eq: ALL };
	assert.equal(FL.cardMatches(CARDS[1].tags, CARDS[1].eq, state), true);
	assert.equal(FL.cardMatches(CARDS[0].tags, CARDS[0].eq, state), false);
});

test('cardMatches: catalog filter checks the same data-tags list', () => {
	const state = { type: ALL, cat: 'caldwell', eq: ALL };
	assert.equal(FL.cardMatches(CARDS[2].tags, CARDS[2].eq, state), true);
	assert.equal(FL.cardMatches(CARDS[1].tags, CARDS[1].eq, state), false);
});

test('cardMatches: equipment filter checks the single data-equipment slug', () => {
	const state = { type: ALL, cat: ALL, eq: 'itelescope' };
	assert.equal(FL.cardMatches(CARDS[2].tags, CARDS[2].eq, state), true);
	assert.equal(FL.cardMatches(CARDS[0].tags, CARDS[0].eq, state), false);
});

test('cardMatches: all three dimensions combine with AND', () => {
	// "Messier galaxies shot on my personal rig" — only card 1 qualifies.
	const state = { type: 'galaxy', cat: 'messier', eq: 'personal' };
	assert.equal(FL.cardMatches(CARDS[1].tags, CARDS[1].eq, state), true);
	// Card 2 is a galaxy but Caldwell + itelescope — fails cat AND eq.
	assert.equal(FL.cardMatches(CARDS[2].tags, CARDS[2].eq, state), false);
});

test('cardMatches: a combination with no member excludes every card', () => {
	// Galaxy + itelescope exists (card 2), but not with Messier.
	const state = { type: 'galaxy', cat: 'messier', eq: 'itelescope' };
	for (const card of CARDS) {
		assert.equal(FL.cardMatches(card.tags, card.eq, state), false);
	}
});

test('cardMatches: empty data-tags (split of "") never matches a real tag', () => {
	// A card with no tags string splits to [""], which must not match "galaxy".
	assert.equal(FL.cardMatches([''], 'personal', { type: 'galaxy', cat: ALL, eq: ALL }), false);
});

// ── applyState + counts + empty state ────────────────────────────────────────
test('applyState: unfiltered shows all cards, count equals total', () => {
	const r = FL.applyState(CARDS, UNFILTERED);
	assert.equal(r.visibleCount, CARDS.length);
	assert.deepEqual(r.visibility, [true, true, true, true, true]);
});

test('applyState: combined filter narrows to exactly the matching cards', () => {
	const state = { type: 'galaxy', cat: 'messier', eq: 'personal' };
	const r = FL.applyState(CARDS, state);
	assert.equal(r.visibleCount, 1);
	assert.deepEqual(r.visibility, [false, true, false, false, false]);
});

test('applyState: empty state — a filter matching nothing yields zero visible', () => {
	const state = { type: 'galaxy', cat: 'messier', eq: 'itelescope' };
	const r = FL.applyState(CARDS, state);
	assert.equal(r.visibleCount, 0);
	assert.ok(r.visibility.every(v => v === false), 'no card should be visible');
});

test('countLabel: unfiltered reads "Showing all N images"', () => {
	assert.equal(FL.countLabel(5, 5, UNFILTERED), 'Showing all 5 images');
});

test('countLabel: filtered reads "Showing X of N images"', () => {
	const state = { type: 'galaxy', cat: ALL, eq: ALL };
	assert.equal(FL.countLabel(2, 5, state), 'Showing 2 of 5 images');
});

test('countLabel: filtered with zero matches still reads "Showing 0 of N"', () => {
	const state = { type: 'galaxy', cat: 'messier', eq: 'itelescope' };
	assert.equal(FL.countLabel(0, 5, state), 'Showing 0 of 5 images');
});

test('isFiltered: true when any dimension constrained, false when all wildcard', () => {
	assert.equal(FL.isFiltered(UNFILTERED), false);
	assert.equal(FL.isFiltered({ type: 'galaxy', cat: ALL, eq: ALL }), true);
	assert.equal(FL.isFiltered({ type: ALL, cat: ALL, eq: 'solar' }), true);
});

// ── toggle semantics ─────────────────────────────────────────────────────────
test('toggleType: clicking a new value selects it', () => {
	assert.equal(FL.toggleType(ALL, 'galaxy'), 'galaxy');
});

test('toggleType: clicking the active value clears it to all', () => {
	assert.equal(FL.toggleType('galaxy', 'galaxy'), ALL);
});

test('toggleType: clicking the explicit "all" button always clears', () => {
	assert.equal(FL.toggleType('galaxy', ALL), ALL);
	assert.equal(FL.toggleType(ALL, ALL), ALL);
});

test('toggleDimension: click sets, re-click on active clears (no all button)', () => {
	assert.equal(FL.toggleDimension(ALL, 'messier'), 'messier');
	assert.equal(FL.toggleDimension('messier', 'messier'), ALL);
	assert.equal(FL.toggleDimension('messier', 'caldwell'), 'caldwell');
});

// ── URL parse / validate / restore ───────────────────────────────────────────
const VALID = {
	types: ['all', 'galaxy', 'emission-nebula', 'solar', 'supernova-remnant'],
	cats:  ['messier', 'caldwell'],
	eqs:   ['personal', 'itelescope', 'solar'],
};

test('validateValue: null / absent param → all', () => {
	assert.equal(FL.validateValue(null, VALID.types), ALL);
	assert.equal(FL.validateValue(undefined, VALID.types), ALL);
});

test('validateValue: a known value passes through', () => {
	assert.equal(FL.validateValue('galaxy', VALID.types), 'galaxy');
});

test('validateValue: an unknown value falls back to all', () => {
	// Stale shared link, hand-typed junk, or a since-removed tag.
	assert.equal(FL.validateValue('quasar', VALID.types), ALL);
	assert.equal(FL.validateValue('', VALID.types), ALL);
});

test('parseState: valid params restore all three dimensions', () => {
	const state = FL.parseState(
		{ type: 'galaxy', cat: 'messier', eq: 'personal' },
		VALID
	);
	assert.deepEqual(state, { type: 'galaxy', cat: 'messier', eq: 'personal' });
});

test('parseState: invalid URL state — one bad param does not poison the others', () => {
	// cat is junk; type and eq are valid and must survive.
	const state = FL.parseState(
		{ type: 'galaxy', cat: 'not-a-catalog', eq: 'personal' },
		VALID
	);
	assert.deepEqual(state, { type: 'galaxy', cat: ALL, eq: 'personal' });
});

test('parseState: absent params default each dimension to all', () => {
	const state = FL.parseState({ type: null, cat: null, eq: null }, VALID);
	assert.deepEqual(state, UNFILTERED);
});

// ── paramOps: URL write plan ─────────────────────────────────────────────────
test('paramOps: unconstrained dimensions are deleted (null), constrained set', () => {
	const ops = FL.paramOps({ type: 'galaxy', cat: ALL, eq: 'personal' });
	const byParam = Object.fromEntries(ops.map(o => [o.param, o.value]));
	assert.equal(byParam.type, 'galaxy');
	assert.equal(byParam.cat, null);   // "all" → delete
	assert.equal(byParam.eq, 'personal');
});

test('paramOps: fully unfiltered state deletes every param (clean URL)', () => {
	const ops = FL.paramOps(UNFILTERED);
	assert.ok(ops.every(o => o.value === null), 'every param should be deleted when unfiltered');
});

// ── round-trip: parseState(paramOps(state)) recovers the state ───────────────
test('round-trip: a state survives paramOps → parseState unchanged', () => {
	const original = { type: 'galaxy', cat: 'messier', eq: 'personal' };
	// paramOps gives {param, value|null}; a null means the param is absent on read.
	const params = {};
	for (const op of FL.paramOps(original)) {
		params[op.param] = op.value; // null models an absent param
	}
	const restored = FL.parseState(params, VALID);
	assert.deepEqual(restored, original);
});
