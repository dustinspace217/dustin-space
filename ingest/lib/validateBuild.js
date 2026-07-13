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
const { run } = require('./exec');

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
 * Why bounded-run: a runaway build (accidental infinite pagination, a huge
 * generated page) is capped on memory/CPU by the workspace's bounded-run
 * wrapper instead of taking down the machine. Matches how the CI/build-smoke
 * work invokes Eleventy.
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
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function validateBuild(projectRoot, emit) {
	// mkdtemp gives a collision-free tmp dir even if two validations overlap.
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-build-'));
	if (emit) emit('Validating: running production build...');
	try {
		// bounded-run <cmd> <args...> — bounded-run execs the rest of argv under
		// systemd resource caps. Eleventy's own CLI takes --output to redirect
		// the build away from the real _site/. A generous timeout: the full site
		// build is fast (~seconds), but DZI-heavy first builds and a cold npx
		// resolve can take longer, so cap at 5 minutes rather than risk a
		// false-negative on a slow machine.
		const { error, stdout, stderr } = await run(
			'bounded-run',
			['npx', '@11ty/eleventy', '--output', outDir],
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
