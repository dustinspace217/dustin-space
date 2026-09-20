/**
 * tests/now-imaging/overrides.test.js — pins for the REAL now-imaging/overrides.json.
 *
 * resolve.test.js injects its own override objects, so nothing else in the
 * suite ever parses the committed file. That matters more than it looks:
 * lib/resolve.js reads an entry as `name || rawName` and `designation || null`,
 * so a mistyped field ("nmae") is not an error anywhere — the card silently
 * shows the raw NINA target and the log says "(unresolved)". And a JSON syntax
 * error is found only when the agent next starts on the rig. This file is the
 * one place either mistake turns red before it ships.
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const FILE = path.join(__dirname, '..', '..', 'now-imaging', 'overrides.json');

test('overrides.json: parses, and every entry has exactly the two string fields the resolver reads', () => {
	const overrides = JSON.parse(fs.readFileSync(FILE, 'utf8'));
	// Keys starting with "_" are comments; the resolver skips them.
	const entries = Object.entries(overrides).filter(([key]) => !key.startsWith('_'));
	assert.ok(entries.length > 0, 'the file carries at least one real override');
	for (const [key, value] of entries) {
		assert.deepEqual(Object.keys(value).sort(), ['designation', 'name'], `entry "${key}" has only name + designation`);
		assert.ok(typeof value.name === 'string' && value.name.length > 0, `entry "${key}" has a non-empty name`);
		assert.ok(typeof value.designation === 'string' && value.designation.length > 0, `entry "${key}" has a non-empty designation`);
	}
});

test('overrides.json: the compound Andromeda target is spelled the way NINA sends it', () => {
	// The key must equal NINA's TargetName after lowercasing and whitespace
	// collapse (lib/resolve.js normalizeKey). A test cannot know what NINA sends;
	// this literal was copied from the rig's own log on 2026-09-20, where every
	// line read `published … target="M31+M110+M32" -> "Andromeda Galaxy / M 31"`
	// once the agent had been restarted with this entry. No spaces around "+":
	// "M31 + M110 + M32" would miss and fall through to Simbad, which cannot
	// resolve a plus-joined name.
	const overrides = JSON.parse(fs.readFileSync(FILE, 'utf8'));
	assert.deepEqual(overrides['M31+M110+M32'], { name: 'Andromeda Galaxy', designation: 'M 31' });
});
