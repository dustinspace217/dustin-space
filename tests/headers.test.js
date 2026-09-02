/**
 * tests/headers.test.js — static pins on src/_headers (QA 2026-08-06, TA-6).
 *
 * The operational half of HSTS (does Cloudflare Pages actually serve the
 * header) is deploy-time behavior no suite can reach. What IS pinnable is the
 * config file's contract, and one clause matters more than the rest: the
 * header value must NOT contain `preload`. Chrome's preload list is
 * effectively a one-way door (removal takes months and a release cycle), and
 * _headers' own comment records its absence as a decision reserved for
 * Dustin. A future well-meaning "harden the security headers" edit adding it
 * is exactly the silent, hard-to-reverse regression this file exists to
 * catch.
 *
 * Deliberately line-scoped (CR cross-exam): the word "preload" appears in
 * _headers' COMMENTS several times — documenting the decision — so a naive
 * whole-file grep would fail on day one. Only the header VALUE line counts.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const HEADERS_PATH = path.join(__dirname, '..', 'src', '_headers');

test('_headers: HSTS present, and its VALUE carries no preload token', () => {
	const text = fs.readFileSync(HEADERS_PATH, 'utf8');

	const m = /^\s*Strict-Transport-Security:(.*)$/m.exec(text);
	assert.ok(m, 'src/_headers has no Strict-Transport-Security line (issue #122 regressed)');

	const value = m[1];
	assert.ok(/max-age=\d+/.test(value),
		`HSTS value "${value.trim()}" has no max-age directive`);
	assert.ok(!/preload/i.test(value),
		`HSTS value "${value.trim()}" contains preload — that is a one-way-door ` +
		`opt-in reserved for Dustin (see the comment above the rule); remove it ` +
		`unless he explicitly made that call`);
});

test('_headers: CSP allows live.dustin.space for images and fetches, nowhere else', () => {
	const text = fs.readFileSync(HEADERS_PATH, 'utf8');
	const csp = /^\s*Content-Security-Policy:(.*)$/m.exec(text)[1];
	const directive = (name) => new RegExp(`${name} ([^;]*)`).exec(csp)[1];
	assert.match(directive('img-src'), /https:\/\/live\.dustin\.space/);
	assert.match(directive('connect-src'), /https:\/\/live\.dustin\.space/);
	assert.doesNotMatch(directive('script-src'), /live\.dustin\.space/, 'the live bucket must never be a script source');
});
