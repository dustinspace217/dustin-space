/**
 * tests/build-smoke.test.js — end-to-end build smoke test for the Eleventy site.
 *
 * Issue #96: the unit tests pin individual functions and data shapes, but
 * nothing exercised the actual build. This runs `@11ty/eleventy` into the
 * default _site/ and asserts the things that have silently broken before
 * (numbered 1-5 in the test body; the list below covers the original three):
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

		// 4. See Also coverage, DERIVED from the data through the real
		//    relatedImages function (QA 2026-08-06, Discussion #145, TA-2d/TA-5).
		//    Why derived: the section is conditionally rendered, so a broken
		//    pool reference that made relatedImages return [] everywhere would
		//    just make the feature vanish — indistinguishable from the
		//    legitimate empty state (the Veil page) without an expectation
		//    computed from images.json. Using the real function means this
		//    catches TEMPLATE-side breakage (guard, include, stash/restore);
		//    the algorithm itself is pinned by tests/see-also.test.js.
		const imagesData = JSON.parse(fs.readFileSync(
			path.join(REPO_ROOT, 'src', '_data', 'images.json'), 'utf8'));
		// Replicates src/_data/publishedImages.js: only explicit false is a draft.
		const published = imagesData.filter(img => img.published !== false);
		const relatedImages = require(path.join(
			REPO_ROOT, 'src', 'gallery', 'gallery.11tydata.js'))
			.eleventyComputed.relatedImages;

		// NOTE deliberately absent: an alias-restore assertion. A drafted check
		// ("lightbox aria-label below the strip carries the page's own title")
		// was red-green tested by deleting the restore lines — and it PASSED,
		// i.e. it was vacuous: `image` is a pagination CONTEXT variable that
		// cannot leak (probe-verified), and the genuinely leakable `pv` only
		// surfaces on a strip+no-DZI page, which no current data produces. A
		// build assertion cannot exercise that path; the mechanism note lives
		// in image.njk's see-also comment.
		for (const img of published) {
			const pagePath = path.join(siteDir, 'gallery', img.slug, 'index.html');
			assert.ok(fs.existsSync(pagePath), `gallery/${img.slug}/ was not generated`);
			const html = fs.readFileSync(pagePath, 'utf8');

			// Hero srcset iff the data warrants it (QA 2026-08-06, issue #135.1):
			// a page ships a responsive hero exactly when its primary variant has
			// a real 1200 rendition AND a known width > 1200 — otherwise the
			// template must fall back to single-source (a "1200w" descriptor on a
			// narrower file inverts browser density selection; the whirlpool bug).
			// Keyed on `imagesrcset=` (the hero preload link) rather than bare
			// `srcset=`: it's emitted by exactly one line in the codebase and
			// mirrors the <img> srcset by construction, so this stays immune to
			// srcset ever being added to the shared gallery-card thumbs.
			const hpv = img.variants.find(v => v.primary) || img.variants[0];
			const wantSrcset = Boolean(hpv.preview_1200_url
				&& typeof hpv.preview_width === 'number' && hpv.preview_width > 1200);
			assert.equal(html.includes('imagesrcset='), wantSrcset,
				`gallery/${img.slug}/: hero imagesrcset presence (${html.includes('imagesrcset=')}) `
				+ `doesn't match the data (preview_1200_url=${hpv.preview_1200_url}, `
				+ `preview_width=${hpv.preview_width}) — either the template guard or the `
				+ `rendition data regressed`);

			const expectCards = relatedImages(
				{ image: img, publishedImages: published }).length;
			const sectionCount = (html.match(/class="see-also"/g) || []).length;
			assert.equal(sectionCount, expectCards > 0 ? 1 : 0,
				`gallery/${img.slug}/: ${sectionCount} see-also sections rendered, `
				+ `but relatedImages yields ${expectCards} cards`);
			if (expectCards === 0) continue;

			// Section integrity on every page that has one: the labelling id
			// exists exactly once, and every card thumb carries a non-empty alt
			// (the section reuses the shared card partial — an alt regression
			// there would surface here).
			assert.equal((html.match(/id="see-also-heading"/g) || []).length, 1,
				`gallery/${img.slug}/: see-also-heading id count != 1`);
			const section = html.slice(html.indexOf('class="see-also"'),
				html.indexOf('class="comments-section"'));
			assert.ok(!/<img(?![^>]*alt="[^"]+")/.test(section),
				`gallery/${img.slug}/: a see-also thumb is missing a non-empty alt`);
		}

		// 5. Currently-imaging section ships on the homepage, HIDDEN, with its
		//    dialog — and does NOT appear on the projects page (spec §6.1). The
		//    `hidden` attribute is the no-JS/no-status contract: if a future edit
		//    drops it, the empty card would render on every visit.
		assert.match(indexHtml, /<section class="now-imaging" id="now-imaging" hidden/,
			'index.html is missing the hidden now-imaging section');
		assert.ok(indexHtml.includes('<dialog class="now-dialog" id="now-dialog"'),
			'index.html is missing the What\'s-this dialog');
		assert.ok(!projectsHtml.includes('id="now-imaging"'),
			'projects page unexpectedly carries the now-imaging section');
	} finally {
		// Always remove the isolated build output, even on assertion failure.
		fs.rmSync(siteDir, { recursive: true, force: true });
	}
});
