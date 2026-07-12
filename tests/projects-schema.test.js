/**
 * tests/projects-schema.test.js — schema guard for src/_data/projects.json.
 *
 * Issue #96: the projects page (src/projects/index.njk) reads every field of
 * every entry directly — category, name, tech, links[].label/url, description[]
 * — with no schema and no fallback. A missing key, an empty description, or a
 * malformed link URL renders as a broken row (or a dead `href`) on the live
 * site with no build-time warning. This test pins the contract the template
 * relies on so a hand-edited JSON entry can't ship broken markup.
 *
 * Link hosts are validated against the set ACTUALLY present in the data today:
 * absolute https links to github.com / gist.github.com, plus site-relative
 * links ("/lenia/", …) used by the Claude's Corner explorables. Those relative
 * links are legitimate internal routes, not external URLs, so they're allowed
 * explicitly rather than forced through the URL parser (which has no base to
 * resolve them against).
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const PROJECTS_JSON = path.join(__dirname, '..', 'src', '_data', 'projects.json');
const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));

// Absolute-link hosts in use today. Verified against the current file: every
// absolute link is a github.com repo/PR or a gist.github.com investigation
// writeup. Add a host here (with a note) only when the data legitimately grows
// one — an unexpected host should fail, not silently pass.
const ALLOWED_HOSTS = new Set(['github.com', 'gist.github.com']);

test('projects.json: top level is a non-empty array', () => {
	assert.ok(Array.isArray(projects), 'projects.json must be a JSON array');
	assert.ok(projects.length > 0, 'projects.json must have at least one entry');
});

// Validate each entry independently so a failure names the offending project.
for (const [i, project] of projects.entries()) {
	// Label the subtest by name when available, else by index — makes a failure
	// point straight at the bad entry without hunting through the array.
	const label = project && typeof project.name === 'string' ? project.name : `#${i}`;

	test(`projects.json[${i}] (${label}): required keys and types`, () => {
		// category — rendered as the row's eyebrow label.
		assert.equal(typeof project.category, 'string', 'category must be a string');
		assert.ok(project.category.trim().length > 0, 'category must be non-empty');

		// name — the row heading. Non-empty is load-bearing (empty <h2>).
		assert.equal(typeof project.name, 'string', 'name must be a string');
		assert.ok(project.name.trim().length > 0, 'name must be non-empty');

		// tech — joined with " · " in the template, so it must be an array.
		assert.ok(Array.isArray(project.tech), 'tech must be an array');
		for (const t of project.tech) {
			assert.equal(typeof t, 'string', 'each tech entry must be a string');
		}

		// links — iterated to build the <a> list. Array required; entries may be
		// zero in principle, but each present entry must have a label + url.
		assert.ok(Array.isArray(project.links), 'links must be an array');
		for (const link of project.links) {
			assert.equal(typeof link.label, 'string', 'link.label must be a string');
			assert.ok(link.label.trim().length > 0, 'link.label must be non-empty');
			assert.equal(typeof link.url, 'string', 'link.url must be a string');

			if (link.url.startsWith('/')) {
				// Site-relative internal route (Claude's Corner explorables). No
				// host to check — just require a non-trivial path.
				assert.ok(link.url.length > 1, `relative link.url must have a path: ${link.url}`);
			} else {
				// Absolute link — must parse as https with an allowed host.
				let parsed;
				assert.doesNotThrow(() => { parsed = new URL(link.url); },
					`link.url must be a valid URL or a "/"-relative path: ${link.url}`);
				assert.equal(parsed.protocol, 'https:', `link.url must be https: ${link.url}`);
				assert.ok(ALLOWED_HOSTS.has(parsed.host),
					`link.url host "${parsed.host}" not in allowed set {${[...ALLOWED_HOSTS].join(', ')}}: ${link.url}`);
			}
		}

		// description — array of paragraphs, each rendered in its own <p>.
		assert.ok(Array.isArray(project.description), 'description must be an array');
		assert.ok(project.description.length > 0, 'description must have at least one paragraph');
		for (const para of project.description) {
			assert.equal(typeof para, 'string', 'each description paragraph must be a string');
			assert.ok(para.trim().length > 0, 'description paragraphs must be non-empty');
		}
	});
}
