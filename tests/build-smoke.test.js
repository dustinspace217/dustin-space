/**
 * tests/build-smoke.test.js — end-to-end build smoke test for the Eleventy site.
 *
 * Issue #96: the unit tests pin individual functions and data shapes, but
 * nothing exercised the actual build. This runs `@11ty/eleventy` into the
 * default _site/ and asserts three things that have silently broken before:
 *   1. the homepage renders with the hero wordmark (<h1 class="hero-logo">,
 *      added this session) — catches a broken index template or missing partial;
 *   2. the projects page renders exactly one <article> per projects.json entry
 *      (count DERIVED from the data, never hardcoded) — catches a template that
 *      drops or duplicates rows when the data grows;
 *   3. the projects page does NOT pull in gallery.js — that script is gated on
 *      `galleryPage` front matter and must stay off non-gallery pages (keeps
 *      them lean; a stray include would mean the gate regressed).
 *
 * This is an integration test: it shells out to a real build, so it's slower
 * than the unit suite and can be skipped with SKIP_BUILD_TESTS=1 (e.g. during
 * fast inner-loop test runs where the build was already verified).
 */

'use strict';

const { test }    = require('node:test');
const assert      = require('node:assert/strict');
const fs          = require('node:fs');
const os          = require('node:os');
const path        = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT     = path.join(__dirname, '..');
const PROJECTS_JSON = path.join(REPO_ROOT, 'src', '_data', 'projects.json');

// Skip switch for fast inner-loop runs. node:test's `skip` option takes a
// string reason (shown in output) or false to run.
const skipReason = process.env.SKIP_BUILD_TESTS === '1' ? 'SKIP_BUILD_TESTS=1' : false;

/**
 * Is `bounded-run` on PATH? Locally the build is wrapped in it (a systemd
 * --user resource-capping scope); in CI it doesn't exist and we call npx
 * directly. Scans PATH for an executable named bounded-run.
 */
function hasBoundedRun() {
	const dirs = (process.env.PATH || '').split(path.delimiter);
	return dirs.some(dir => {
		try {
			fs.accessSync(path.join(dir, 'bounded-run'), fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

/**
 * Are we ALREADY inside a bounded-run scope? bounded-run runs its command in a
 * transient systemd scope whose cgroup leaf looks like `run-p<pid>-i<inv>.scope`.
 * When this whole test suite is launched via `bounded-run npm test`, wrapping
 * the build in a SECOND bounded-run nests scopes and fails on a unit-name
 * collision — so if we detect we're already scoped, we skip the wrapper (the
 * outer scope's caps already apply). Reads the cgroup on Linux; anything else
 * (missing /proc, non-Linux CI) counts as not-scoped.
 */
function insideBoundedScope() {
	try {
		const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
		return /\/run-p\d+-i\d+\.scope\s*$/m.test(cgroup);
	} catch {
		return false;
	}
}

test('build smoke: eleventy build produces expected pages', { skip: skipReason, timeout: 180000 }, () => {
	// Build into a UNIQUE temp output dir rather than the repo's default _site/.
	// Why: a concurrent `npm start`/dev build, another test, or a parallel CI
	// job could otherwise read a half-written or stale _site/ — and the smoke
	// test would clobber the developer's live dev output. A per-run mkdtemp dir
	// isolates this build completely; the finally block removes it.
	const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dustin-site-'));
	try {
		// Decide how to invoke the build. Use bounded-run only when it exists AND we
		// aren't already inside one — otherwise a bare npx (CI, or the nested case).
		// `--output <dir>` points eleventy at the isolated temp dir.
		const useBounded = hasBoundedRun() && !insideBoundedScope();
		const cmd  = useBounded ? 'bounded-run' : 'npx';
		const eleventyArgs = ['@11ty/eleventy', '--output', siteDir];
		const args = useBounded ? ['npx', ...eleventyArgs] : eleventyArgs;

		// Run synchronously from the repo root so eleventy finds .eleventy.js and
		// src/. Generous timeout tolerates a cold first build.
		const result = spawnSync(cmd, args, {
			cwd: REPO_ROOT,
			timeout: 120000,
			encoding: 'utf8',
		});

		assert.equal(result.error, undefined,
			`build failed to spawn (${cmd}): ${result.error && result.error.message}`);
		assert.equal(result.status, 0,
			`eleventy build exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

		// 1. Homepage renders with the hero wordmark.
		const indexPath = path.join(siteDir, 'index.html');
		assert.ok(fs.existsSync(indexPath), 'index.html was not generated');
		const indexHtml = fs.readFileSync(indexPath, 'utf8');
		assert.ok(indexHtml.includes('<h1 class="hero-logo"'),
			'index.html is missing the <h1 class="hero-logo"> hero wordmark');

		// 2. Projects page renders exactly one <article> per projects.json entry.
		//    Count is derived from the data, so adding a project keeps this honest.
		//    The regex requires a tag-terminating char after "article" (`<article>`,
		//    `<article class=…`, `<article/>`) so a hypothetical custom element like
		//    `<article-card>` can't inflate the count.
		const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
		const projectsPath = path.join(siteDir, 'projects', 'index.html');
		assert.ok(fs.existsSync(projectsPath), 'projects/index.html was not generated');
		const projectsHtml = fs.readFileSync(projectsPath, 'utf8');
		const articleCount = (projectsHtml.match(/<article[\s/>]/g) || []).length;
		assert.equal(articleCount, projects.length,
			`projects page has ${articleCount} <article> rows but projects.json has ${projects.length} entries`);

		// 3. Projects page must not pull in the gallery.js SCRIPT (gated on galleryPage
		//    front matter). Match the <script src="…gallery.js…"> tag, not the bare
		//    string — the base layout carries an HTML comment that names gallery.js in
		//    prose, and that comment is expected output, not a regression.
		assert.ok(!/src="[^"]*gallery\.js/.test(projectsHtml),
			'projects/index.html unexpectedly includes the gallery.js script tag — the galleryPage gate regressed');
	} finally {
		// Always remove the isolated build output, even on assertion failure.
		fs.rmSync(siteDir, { recursive: true, force: true });
	}
});
