/**
 * tests/ingest-pipeline.test.js — dependency-injection tests for the ingest
 * pipeline orchestrator (ingest/lib/pipeline.js), exercising the public
 * runPipeline seam with INJECTED fakes so no real R2 upload, vips call, git
 * push, or images.json write happens.
 *
 * Issue #118 (Fix Wave 2 W7): the pipeline had zero orchestration coverage.
 * These pin the two paths that matter for publish integrity (W2):
 *   1. SUCCESS — a minimal new-target job runs end to end and emits a terminal
 *      `done` event carrying the slug, having called the gallery write layer.
 *   2. POST-UPLOAD FAILURE — the DZI tiles upload but a later step fails; the
 *      pipeline must emit a terminal error and must NOT commit an images.json
 *      entry (the W2 "gate publish on upload/write failure" contract).
 *
 * ── Injection contract (reconcile with W2 / agent A) ──────────────────────────
 * These tests drive the pipeline through injected side-effect functions rather
 * than the real modules. That requires runPipeline to accept an optional 4th
 * `deps` argument whose members OVERRIDE the module-level requires when present:
 *
 *   runPipeline(jobId, files, body, deps)
 *     deps.getImageDimensions, deps.generatePreviewWebp, deps.generateThumbWebp,
 *     deps.generateDzi, deps.uploadDziToR2, deps.addTarget, deps.addVariant,
 *     deps.addRevision, deps.findTarget, deps.slugExists,
 *     deps.run, deps.runOrThrow, deps.validateBuild
 *   (each optional; the pipeline falls back to the real import when absent)
 *
 * Wave-2 stabilization: the seam now EXISTS, so these tests no longer skip when
 * it's absent — they HARD-FAIL. The first test below asserts the seam is present
 * (module loads, runPipeline arity >= 4); a wholesale revert of the deps seam
 * drops the arity and turns the suite RED rather than silently skipped. The DI
 * tests then always run with injected fakes so no real R2 upload, git push, or
 * images.json write ever happens.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

// ── Load the pipeline + job store defensively ─────────────────────────────────
// Requiring the pipeline pulls in the whole ingest module chain (config, r2 →
// @aws-sdk, …). If any of that is unavailable in this runtime, skip cleanly.
let pipelineMod, jobsMod, loadError = null;
try {
	pipelineMod = require('../ingest/lib/pipeline');
	jobsMod     = require('../ingest/lib/jobs');
} catch (err) {
	loadError = err.message;
}

// Hard seam assertion (replaces the old skip-on-absence guard). If the pipeline
// failed to load, isn't exported, or lost its 4th `deps` parameter (a revert of
// the DI seam), this test goes RED — the DI coverage below can never be silently
// skipped into vacuity again.
test('ingest pipeline DI seam is present (hard requirement, not skipped)', () => {
	assert.equal(loadError, null,
		`the ingest pipeline module must load for these DI tests: ${loadError}`);
	const fn = pipelineMod && pipelineMod.runPipeline;
	assert.equal(typeof fn, 'function', 'runPipeline must be exported');
	assert.ok(fn.length >= 4,
		'runPipeline must declare the injected deps parameter (4th arg) — the DI seam. '
		+ 'A revert of the seam drops the arity below 4 and turns this RED.');
});

/**
 * makeJob — register a job in the shared jobs Map with a listener that collects
 * every emitted SSE event as a parsed object, and a promise that resolves with
 * the full event list once a terminal `done` event arrives (or on timeout).
 * @returns {{ jobId:string, done:Promise<object[]> }}
 */
function makeJob() {
	const jobId = 'test-' + Math.random().toString(16).slice(2);
	const events = [];
	let resolveDone;
	const done = new Promise(res => { resolveDone = res; });
	jobsMod.jobs.set(jobId, {
		events: [],
		cancelled: false,
		status: 'running',
		// jobEmit pushes the raw SSE line ("data: {…}\n\n"); parse the JSON back.
		listeners: [line => {
			const m = /^data: (.*)\n\n$/s.exec(line);
			if (!m) return;
			const evt = JSON.parse(m[1]);
			events.push(evt);
			if (evt.type === 'done') resolveDone(events);
		}],
	});
	return { jobId, done };
}

/**
 * makeFiles — a fake multer files object. The pipeline only reads `.path` and,
 * in the finally block, fs.rm()s each — so the paths point at real temp files
 * we create, keeping cleanup a no-op-safe real unlink.
 */
function makeFiles(tmpDir, opts = {}) {
	const files = {};
	const touch = name => {
		const p = path.join(tmpDir, name);
		fs.writeFileSync(p, '');
		return { path: p, originalname: name };
	};
	files.jpg = [touch('src.jpg')];
	if (opts.tif) files.tif = [touch('src.tif')];
	return files;
}

// Baseline deps — all side effects faked to resolve without touching R2, vips,
// git, or images.json. Individual tests override members to force a failure.
function baseDeps(overrides = {}) {
	return Object.assign({
		getImageDimensions: async () => ({ width: 6000, height: 4000 }),
		generatePreviewWebp: async () => {},
		generateThumbWebp:   async () => {},
		generateDzi:         async () => {},
		// Real R2 returns { uploadedKeys }; W2 adds { failed }. Success = no failures.
		uploadDziToR2:       async () => ({ uploadedKeys: ['a', 'b', 'c'], failed: [] }),
		slugExists:          () => false,
		findTarget:          () => undefined,
		addTarget:           async (_entry, onCommit) => { if (onCommit) { /* skip real rename */ } },
		addVariant:          async () => {},
		addRevision:         async () => {},
	}, overrides);
}

test('ingest pipeline: minimal new-target job succeeds and emits done+slug', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-pipe-ok-'));
	try {
		const { jobId, done } = makeJob();
		let addTargetCalled = false;
		const deps = baseDeps({
			addTarget: async () => { addTargetCalled = true; },
		});
		const files = makeFiles(tmpDir);
		// dzi/gitpush/platesolve/simbad all off → the leanest publish path.
		const body = { mode: 'new-target', slug: 'test-slug', title: 'Test',
			dzi: 'false', gitpush: 'false', platesolve: 'false', simbad: 'false' };

		await pipelineMod.runPipeline(jobId, files, body, deps);
		const events = await done;

		const doneEvt = events.find(e => e.type === 'done');
		assert.ok(doneEvt, 'a terminal done event must be emitted');
		assert.equal(doneEvt.slug, 'test-slug', 'done event carries the created slug');
		assert.ok(!doneEvt.error, 'success path must not carry an error');
		assert.ok(addTargetCalled, 'the gallery write layer (addTarget) must be called');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('ingest pipeline: DZI upload failure aborts before writing images.json', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-pipe-fail-'));
	try {
		const { jobId, done } = makeJob();
		let addTargetCalled = false;
		const deps = baseDeps({
			// Post-upload failure: some tile objects failed to upload. Per the W2
			// contract the pipeline must abort before publishing the entry.
			uploadDziToR2: async () => ({ uploadedKeys: ['a'], failed: ['b', 'c'] }),
			addTarget: async () => { addTargetCalled = true; },
		});
		const files = makeFiles(tmpDir, { tif: true });
		// dzi on (so the upload runs), gitpush off.
		const body = { mode: 'new-target', slug: 'test-slug', title: 'Test',
			dzi: 'true', gitpush: 'false', platesolve: 'false', simbad: 'false' };

		await pipelineMod.runPipeline(jobId, files, body, deps);
		const events = await done;

		const errEvt = events.find(e => e.type === 'error');
		assert.ok(errEvt, 'an error event must be emitted on upload failure');
		const doneEvt = events.find(e => e.type === 'done');
		assert.ok(doneEvt && (doneEvt.error || doneEvt.slug == null),
			'the terminal done event must signal failure (error set / slug null)');
		assert.ok(!addTargetCalled, 'images.json write (addTarget) must NOT run after an upload failure');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('ingest pipeline: gitpush path aborts before git add when the build gate fails', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-pipe-buildfail-'));
	try {
		const { jobId, done } = makeJob();
		let addTargetCalled = false;
		const gitCalls = [];
		const deps = baseDeps({
			// Force the pre-push production-build gate (validateBuild) to report
			// failure. The pipeline must throw and NOT proceed to stage/commit/push.
			validateBuild: async () => ({ ok: false, error: 'a template threw at build time' }),
			// Capture every git invocation so we can assert `git add` never ran.
			// Injected so the test never touches the real repository.
			runOrThrow: async (cmd, args) => { if (cmd === 'git') gitCalls.push(args); return ''; },
			addTarget: async () => { addTargetCalled = true; },
		});
		const files = makeFiles(tmpDir);
		// gitpush ON so the build gate runs; dzi/platesolve/simbad OFF for the lean path.
		const body = { mode: 'new-target', slug: 'build-fail-slug', title: 'BuildFail',
			dzi: 'false', gitpush: 'true', platesolve: 'false', simbad: 'false' };

		await pipelineMod.runPipeline(jobId, files, body, deps);
		const events = await done;

		// The images.json write happens BEFORE the build gate (the gate must see the
		// real file on disk), so addTarget ran — the entry is on the local tree...
		assert.ok(addTargetCalled, 'images.json write happens before the build gate');
		// ...but a failing gate must abort before staging anything with git.
		const errEvt = events.find(e => e.type === 'error');
		assert.ok(errEvt, 'a build-failure error event must be emitted');
		assert.match(errEvt.message, /build/i, 'the error must name the build failure');
		const gitAddCalled = gitCalls.some(args => args.includes('add'));
		assert.ok(!gitAddCalled, 'git add must NOT run after the build gate fails');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
