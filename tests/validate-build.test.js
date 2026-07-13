/**
 * tests/validate-build.test.js — the pre-push production-build gate
 * (ingest/lib/validateBuild.js) exercised with an INJECTED runner, so the
 * gate's pass/fail decision is tested WITHOUT actually spawning Eleventy.
 *
 * Issue #118 (Fix Wave 2, stabilization): validateBuild.js grew a `deps.run`
 * injection seam (mirroring runPipeline's) precisely so this decision — does a
 * non-zero build exit reject the gate, and does a clean exit pass it? — is
 * unit-testable in milliseconds. It also grew a bounded-run PATH fallback so it
 * runs in CI (where bounded-run doesn't exist); that launcher choice is covered
 * indirectly here by asserting the Eleventy command/args reach the runner.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// Hard require — a revert of validateBuild.js turns this suite RED, not skipped.
const { validateBuild } = require('../ingest/lib/validateBuild');

test('validateBuild reports ok:false when the injected build runner fails', async () => {
	// The real exec.run never throws; it resolves { error, stdout, stderr }. A
	// non-null error is a non-zero Eleventy exit — the gate must reject and surface
	// the log tail.
	const fakeRun = async () => ({
		error:  new Error('exit 1'),
		stdout: '',
		stderr: 'Template render error: boom',
	});
	const result = await validateBuild('/nonexistent/project', null, { run: fakeRun });
	assert.equal(result.ok, false, 'a failing build must reject the gate');
	assert.match(result.error, /boom/, 'the gate surfaces the build log tail');
});

test('validateBuild reports ok:true when the injected build runner succeeds', async () => {
	const fakeRun = async () => ({ error: null, stdout: 'Wrote 12 files', stderr: '' });
	const result = await validateBuild('/nonexistent/project', null, { run: fakeRun });
	assert.equal(result.ok, true, 'a succeeding build must pass the gate');
	assert.equal(result.error, null);
});

test('validateBuild drives Eleventy from the project root via the injected runner', async () => {
	let seen = null;
	const fakeRun = async (cmd, args, opts) => {
		seen = { cmd, args, opts };
		return { error: null, stdout: '', stderr: '' };
	};
	await validateBuild('/some/root', null, { run: fakeRun });
	assert.ok(seen, 'the runner must be invoked');
	// Whether launched via bounded-run or bare npx, Eleventy + a redirected output
	// dir must be in the args, and the build must run from the project root.
	assert.ok(seen.args.includes('@11ty/eleventy'), 'Eleventy is the build command');
	assert.ok(seen.args.includes('--output'), 'the build output is redirected via --output');
	assert.equal(seen.opts.cwd, '/some/root', 'the build runs from the project root');
});
