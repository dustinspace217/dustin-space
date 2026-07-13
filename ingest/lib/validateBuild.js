/**
 * validateBuild.js — production-build validation gate for the ingest pipeline
 *
 * W2 publish-integrity: before the pipeline commits + pushes a new images.json
 * entry, prove the site still BUILDS with that entry in place. The in-process
 * structural validator (validateImages.js) catches shape corruption, but a
 * value that is structurally valid yet trips a template (a malformed date a
 * Nunjucks filter chokes on, an unescaped sequence, a missing referenced asset)
 * only surfaces at build time. A broken build pushed to `main` deploys a broken
 * site on Cloudflare Pages. This runs the real Eleventy build as the last check
 * before the irreversible git push.
 *
 * Exports:
 *   validateBuild(projectRoot, emit) — returns { ok: boolean, error: string|null }
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const execLib = require('./exec');

/**
 * hasBoundedRun — is a `bounded-run` executable on PATH? Locally the build is
 * wrapped in it (a systemd --user resource-capping scope); in CI it doesn't
 * exist and Eleventy is invoked via npx directly. Scans every PATH dir for an
 * executable named bounded-run. Copied from tests/build-smoke.test.js so the
 * server-side build gate and the smoke test agree on how to launch Eleventy.
 *
 * @returns {boolean} true if bounded-run is available
 */
function hasBoundedRun() {
	const dirs = (process.env.PATH || '').split(path.delimiter);
	return dirs.some((dir) => {
		try {
			fs.accessSync(path.join(dir, 'bounded-run'), fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

/**
 * insideBoundedScope — are we ALREADY inside a bounded-run scope? bounded-run
 * runs its command in a transient systemd scope whose cgroup leaf looks like
 * `run-p<pid>-i<inv>.scope`. When the ingest server itself was launched via
 * `bounded-run`, wrapping the Eleventy build in a SECOND bounded-run nests
 * scopes and fails on a unit-name collision — so if we're already scoped, skip
 * the wrapper (the outer scope's caps already apply). Reads the cgroup on Linux;
 * anything else (missing /proc, non-Linux) counts as not-scoped. Copied from
 * tests/build-smoke.test.js.
 *
 * @returns {boolean} true if the current process is already in a bounded-run scope
 */
function insideBoundedScope() {
	try {
		const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
		return /\/run-p\d+-i\d+\.scope\s*$/m.test(cgroup);
	} catch {
		return false;
	}
}

/**
 * validateBuild — run a full Eleventy production build to a throwaway output
 * directory and report whether it succeeded.
 *
 * Why a temp output dir (not the real _site/): a validation must have no side
 * effects on the working tree. Building into a fresh tmp dir means a concurrent
 * `npm start` dev server's _site/ is untouched, and the tmp tree is removed in
 * the finally block regardless of outcome. cwd is set to projectRoot so
 * Eleventy resolves .eleventy.js and src/ exactly as it does in production.
 *
 * Why bounded-run — WITH a PATH fallback: a runaway build (accidental infinite
 * pagination, a huge generated page) is capped on memory/CPU by the workspace's
 * bounded-run wrapper instead of taking down the machine. But bounded-run only
 * exists on Dustin's local box; in CI (and any environment without it) the old
 * code hard-failed to spawn `bounded-run`. So detect it exactly the way
 * build-smoke.test.js does — present on PATH AND not already nested in a scope —
 * and fall back to a plain `npx` when it's absent. Same launch decision on both
 * the server gate and the smoke test.
 *
 * Failure surfacing: `run` never throws — it resolves { error }. On a non-zero
 * exit we return ok:false with a trimmed tail of stderr/stdout (Eleventy prints
 * the failing template + error there), so the caller can put the real reason in
 * front of the owner rather than a generic "build failed".
 *
 * @param {string} projectRoot — absolute path to the dustin-space repo root
 *   (where .eleventy.js lives). Passed from pipeline.js's PROJECT_ROOT.
 * @param {function} [emit] — optional progress callback (message:string) wired
 *   to the SSE `progress` event so the owner sees the validation running.
 * @param {object} [deps] — optional dependency-injection seam (mirrors
 *   runPipeline's deps): `deps.run` overrides the real exec.run so tests can
 *   fake a succeeding/failing build without spawning Eleventy. Absent in
 *   production, where the real run is used.
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function validateBuild(projectRoot, emit, deps) {
	deps = deps || {};
	const run = deps.run || execLib.run;
	// mkdtemp gives a collision-free tmp dir even if two validations overlap.
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-build-'));
	if (emit) emit('Validating: running production build...');
	try {
		// Decide the launcher exactly like build-smoke.test.js: use bounded-run
		// only when it's on PATH AND we're not already inside a scope; otherwise a
		// bare npx. `--output <dir>` redirects the build away from the real _site/.
		const useBounded = hasBoundedRun() && !insideBoundedScope();
		const cmd = useBounded ? 'bounded-run' : 'npx';
		const eleventyArgs = ['@11ty/eleventy', '--output', outDir];
		const args = useBounded ? ['npx', ...eleventyArgs] : eleventyArgs;
		// A generous timeout: the full site build is fast (~seconds), but DZI-heavy
		// first builds and a cold npx resolve can take longer, so cap at 5 minutes
		// rather than risk a false-negative on a slow machine.
		const { error, stdout, stderr } = await run(
			cmd,
			args,
			{ cwd: projectRoot, timeout: 5 * 60 * 1000 }
		);
		if (error) {
			// Surface the tail of the build log — that's where Eleventy prints the
			// offending template and the JS error. Trim to keep the SSE line and
			// server console readable.
			const detail = (stderr || stdout || error.message || '').trim().slice(-600);
			return { ok: false, error: detail || 'Eleventy build failed with no output.' };
		}
		return { ok: true, error: null };
	} finally {
		// Always remove the throwaway build output, even on timeout/failure.
		try {
			fs.rmSync(outDir, { recursive: true, force: true });
		} catch (cleanupErr) {
			console.error(`[validateBuild] Failed to remove temp build dir ${outDir}:`, cleanupErr.message);
		}
	}
}

module.exports = { validateBuild };
