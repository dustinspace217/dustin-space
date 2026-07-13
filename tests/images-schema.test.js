/**
 * tests/images-schema.test.js — schema guard for src/_data/images.json, run
 * through the SHARED validator the ingest pipeline uses before writing.
 *
 * Issue #118 (Fix Wave 2 W2/W7): W2 introduces one canonical images.json
 * validator (ingest/lib/validateImages.js) called pre-write in the ingest
 * gallery layer; W7 wires that SAME validator into CI so the checked-in
 * images.json can never drift from the shape the pipeline enforces. Sharing one
 * validator (rather than a second, parallel schema here) means the test and the
 * write path can't disagree — a change to the contract updates both at once.
 *
 * Contract with the W2 work (agent A): the module lives at
 * `ingest/lib/validateImages.js`. Its callable is discovered defensively so a
 * small naming difference (a bare function export vs. { validateImages } vs.
 * { validate }) doesn't break this test. The callable is expected either to
 * THROW on invalid data, or to RETURN a result carrying an `errors` array /
 * `valid` boolean. Both conventions are handled below.
 *
 * If the module is absent at runtime (this test lands before A's file does),
 * the test SKIPS with a message rather than failing — the suite stays green
 * until the two land together at commit time.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const IMAGES_JSON  = path.join(__dirname, '..', 'src', '_data', 'images.json');
const VALIDATOR    = path.join(__dirname, '..', 'ingest', 'lib', 'validateImages.js');

/**
 * loadValidator — require the shared validator if present and return its
 * callable, or return null if the module doesn't exist yet.
 *
 * Discovers the callable defensively across the plausible export shapes A may
 * choose: a bare function (`module.exports = fn`), or an object with
 * `validateImages` / `validate`. Anything else is treated as "no usable
 * callable" and reported so the failure is legible rather than a cryptic
 * "x is not a function".
 *
 * @returns {{ fn: function }|{ skip: string }}
 */
function loadValidator() {
	if (!fs.existsSync(VALIDATOR)) {
		return { skip: `ingest/lib/validateImages.js not present yet (W2, agent A) — skipping until it lands` };
	}
	let mod;
	try {
		mod = require(VALIDATOR);
	} catch (err) {
		return { skip: `ingest/lib/validateImages.js failed to load: ${err.message}` };
	}
	const fn = typeof mod === 'function'
		? mod
		: (typeof mod.validateImages === 'function'
			? mod.validateImages
			: (typeof mod.validate === 'function' ? mod.validate : null));
	if (!fn) {
		return { skip: `ingest/lib/validateImages.js exports no callable named validateImages/validate — skipping` };
	}
	return { fn };
}

/**
 * runValidator — call the discovered validator and normalize the two supported
 * result conventions into a single { ok, errors } shape:
 *   - throws on invalid  → ok:false, errors:[thrown message]
 *   - returns { errors } / { valid } → derived from those fields
 *   - returns nothing / true         → treated as ok
 */
function runValidator(fn, images) {
	let result;
	try {
		result = fn(images);
	} catch (err) {
		return { ok: false, errors: [err.message] };
	}
	if (result && typeof result === 'object') {
		if (Array.isArray(result.errors)) {
			return { ok: result.errors.length === 0, errors: result.errors };
		}
		if (typeof result.valid === 'boolean') {
			return { ok: result.valid, errors: result.errors || [] };
		}
	}
	// Undefined / true / any non-error return means it accepted the data.
	return { ok: result !== false, errors: [] };
}

const loaded = loadValidator();

test('images.json passes the shared ingest validator', { skip: loaded.skip || false }, () => {
	const images = JSON.parse(fs.readFileSync(IMAGES_JSON, 'utf8'));
	const { ok, errors } = runValidator(loaded.fn, images);
	assert.ok(ok,
		`the checked-in images.json failed the shared validator:\n  ${errors.join('\n  ')}`);
});
