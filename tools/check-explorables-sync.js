#!/usr/bin/env node
/**
 * tools/check-explorables-sync.js — drift detector for the vendored explorables.
 *
 * Three interactive explorables (Lenia, reaction-diffusion, aperture-synthesis)
 * are DEVELOPED in their own sibling repos under ~/Claude and DEPLOYED as
 * verbatim copies under src/ (see .eleventy.js passthrough config). The upstream
 * repo is the source of truth; src/ is a build artifact. That split silently
 * drifts: someone edits the deployed copy directly, or fixes the upstream and
 * forgets to re-sync. This script makes the drift loud.
 *
 * It is a maintenance tool, run by hand (or from CI later) — NOT part of the
 * Eleventy build. Two modes:
 *   node tools/check-explorables-sync.js           → check current state vs the
 *       recorded manifest and report drift; exit 1 if anything is out of sync.
 *   node tools/check-explorables-sync.js --write    → regenerate the manifest
 *       from the current (post-sync) state: recompute hashes, re-read git SHAs,
 *       stamp the sync date. Run this right AFTER copying a fixed upstream into
 *       src/ so the manifest records the new baseline.
 *
 * The "full-tree content hash" (Sol conference ruling 3) is a sha256 over a
 * sorted list of `relpath:sha256(file)` lines — order-independent, and it
 * changes if any tracked byte or filename changes. Committed to
 * explorables-manifest.json at the repo root.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// Repo root is the parent of this tools/ directory; the upstream repos are its
// siblings (~/Claude/<name>), so they resolve as repoRoot/../<name>.
const REPO_ROOT = path.resolve(__dirname, '..');
const SIBLINGS = path.resolve(REPO_ROOT, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'explorables-manifest.json');

// Per-explorable wiring. `source` is the upstream dir (source of truth);
// `deployed` is the vendored copy under src/. `git` marks whether the source has
// its own repo (only lenia-lab does — the other two are un-versioned working
// dirs, so their commit is recorded as null). `excludes` lists path prefixes
// (relative to the source root) that are development-only and never deployed —
// PLAN docs, tests, tooling, screenshots, raw data. Keep these in step with what
// the actual sync copies; a mismatch shows up as a spurious file-set difference.
const EXPLORABLES = [
	{
		id: 'lenia',
		source: path.join(SIBLINGS, 'lenia-lab'),
		deployed: path.join(REPO_ROOT, 'src', 'lenia'),
		git: true,
		excludes: ['.git', '.gitignore', 'PLAN.md', 'QA-FIXES.md', 'README.md',
			'parity.html', 'screenshots', 'test', 'tools', path.join('data', 'raw')],
	},
	{
		id: 'reaction-diffusion',
		source: path.join(SIBLINGS, 'reaction-diffusion'),
		deployed: path.join(REPO_ROOT, 'src', 'reaction-diffusion'),
		git: false,
		excludes: ['PLAN.md', 'bk-test.html', 'screenshots'],
	},
	{
		id: 'aperture-synthesis',
		source: path.join(SIBLINGS, 'aperture-synthesis'),
		deployed: path.join(REPO_ROOT, 'src', 'aperture-synthesis'),
		git: false,
		excludes: ['package.json', 'PLAN.md', 'PLAN-realpipeline.md', 'screenshots',
			'test', 'tools', path.join('src', '_spike_selfcal.js')],
	},
];

// isExcluded — true if `rel` (a path relative to the source root) is at or under
// any excluded prefix. Prefix match on path segments so 'test' excludes 'test/'
// contents without also matching a file literally named 'testbed.js'.
function isExcluded(rel, excludes) {
	return excludes.some((ex) => rel === ex || rel.startsWith(ex + path.sep));
}

// walkFiles — sorted list of file paths relative to `root`, skipping excluded
// prefixes. Recursion is bounded by the file tree (these dirs are a handful of
// files deep); no symlink following. Directories are traversed, files collected.
function walkFiles(root, excludes = []) {
	const out = [];
	const recurse = (absDir, relDir) => {
		for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
			const rel = relDir ? path.join(relDir, entry.name) : entry.name;
			if (isExcluded(rel, excludes)) continue;
			const abs = path.join(absDir, entry.name);
			if (entry.isDirectory()) recurse(abs, rel);
			else if (entry.isFile()) out.push(rel);
		}
	};
	recurse(root, '');
	return out.sort();
}

// fileHash — sha256 of one file's bytes, hex.
function fileHash(abs) {
	return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

// treeHash — the full-tree content hash: sha256 over sorted `relpath:filehash`
// lines. `relpaths` is the canonical file set; each is read from `root`. Returns
// { hash, missing } — `missing` lists relpaths absent under `root` (used to flag
// a deployed file that no longer exists upstream, or vice-versa).
function treeHash(root, relpaths) {
	const lines = [];
	const missing = [];
	for (const rel of relpaths) {
		const abs = path.join(root, rel);
		if (!fs.existsSync(abs)) { missing.push(rel); continue; }
		lines.push(`${rel}:${fileHash(abs)}`);
	}
	const hash = crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
	return { hash, missing };
}

// gitShort — short commit SHA of a source repo, or null if it isn't a git repo
// (the two un-versioned explorables) or git is unavailable. Never throws.
//
// A '-dirty' suffix is appended when the source repo has uncommitted working-tree
// changes. This matters here specifically: lenia-lab's keyboard-access work is
// live in the working tree but NOT committed, so a bare HEAD SHA would falsely
// claim the deployed content matches that commit. If a future session checked out
// the recorded SHA and re-synced, it would silently WIPE the uncommitted a11y work
// (the deployed copy is regenerated from the source). The suffix makes that
// provenance honest; the full-tree `hash` remains the real integrity anchor either
// way. Once the upstream work is committed, --write records the new clean SHA.
function gitShort(dir) {
	try {
		const sha = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'],
			{ encoding: 'utf8' }).trim();
		const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain'],
			{ encoding: 'utf8' }).trim().length > 0;
		return dirty ? `${sha}-dirty` : sha;
	} catch {
		return null;
	}
}

// analyze — compute the current sync facts for one explorable. The canonical
// file set is the UNION of the deployed files and the source's deployable files,
// so a file added on only one side surfaces as `missing` on the other rather than
// being silently ignored.
function analyze(ex) {
	const deployedFiles = walkFiles(ex.deployed);
	const sourceFiles = walkFiles(ex.source, ex.excludes);
	const union = [...new Set([...deployedFiles, ...sourceFiles])].sort();
	const dep = treeHash(ex.deployed, union);   // dep.missing = in source but not deployed
	const src = treeHash(ex.source, union);     // src.missing = in deployed but not source
	return {
		id: ex.id,
		source: path.relative(REPO_ROOT, ex.source),
		deployed: path.relative(REPO_ROOT, ex.deployed),
		deployedHash: dep.hash,
		sourceHash: src.hash,
		sourceCommit: ex.git ? gitShort(ex.source) : null,
		fileCount: union.length,
		inSync: dep.hash === src.hash,
		onlyInSource: dep.missing,   // need syncing INTO src/
		onlyInDeployed: src.missing, // stale in src/ (removed upstream)
	};
}

// writeManifest — regenerate explorables-manifest.json from the current state.
// `hash` is stored once per explorable: right after a clean sync deployedHash ===
// sourceHash, so a single value is the recorded baseline both sides are checked
// against later.
function writeManifest() {
	const generatedAt = new Date().toISOString();
	const manifest = {
		note: 'Sync manifest for the vendored explorables. source = upstream repo '
			+ '(source of truth); deployed = verbatim copy under src/. Regenerate with '
			+ '`node tools/check-explorables-sync.js --write` after syncing an upstream '
			+ 'into src/. Check drift with the same script and no flag.',
		generatedAt,
		explorables: EXPLORABLES.map((ex) => {
			const a = analyze(ex);
			if (!a.inSync) {
				console.warn(`WARN: ${ex.id} is not in sync at write time — `
					+ `manifest will record the DEPLOYED hash. Sync first, then --write.`);
			}
			return {
				id: a.id,
				source: a.source,
				deployed: a.deployed,
				sourceCommit: a.sourceCommit,   // null where the source has no git repo
				hash: a.deployedHash,            // full-tree content hash of the synced copy
				fileCount: a.fileCount,
				syncedAt: generatedAt,
			};
		}),
	};
	fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, '\t') + '\n');
	console.log(`Wrote ${path.relative(REPO_ROOT, MANIFEST_PATH)} `
		+ `(${manifest.explorables.length} explorables, ${generatedAt}).`);
}

// checkManifest — compare current state against the recorded manifest and report.
// Exit code is 1 if ANY explorable has drifted, so CI can gate on it. Three drift
// kinds are distinguished because they call for different actions:
//   - src/ edited directly   (deployedHash ≠ recorded) → revert or push upstream
//   - upstream advanced        (sourceHash ≠ recorded) → re-sync into src/
//   - src/ ≠ upstream          (the two differ now)       → re-sync + --write
function checkManifest() {
	if (!fs.existsSync(MANIFEST_PATH)) {
		console.error(`No manifest at ${path.relative(REPO_ROOT, MANIFEST_PATH)}. `
			+ `Run with --write to create it.`);
		process.exitCode = 1;
		return;
	}
	const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
	const recorded = new Map(manifest.explorables.map((e) => [e.id, e]));
	let drift = false;

	for (const ex of EXPLORABLES) {
		const a = analyze(ex);
		const rec = recorded.get(ex.id);
		const notes = [];
		if (!rec) { notes.push('NOT in manifest (run --write)'); }
		else {
			if (a.deployedHash !== rec.hash) notes.push('src/ edited directly since last sync');
			if (a.sourceHash !== rec.hash) notes.push('upstream advanced since last sync');
			if (rec.sourceCommit !== a.sourceCommit)
				notes.push(`source commit ${rec.sourceCommit || 'null'} → ${a.sourceCommit || 'null'}`);
		}
		if (!a.inSync) notes.push('src/ DIFFERS from upstream right now');
		for (const f of a.onlyInSource) notes.push(`missing in src/: ${f}`);
		for (const f of a.onlyInDeployed) notes.push(`stale in src/ (gone upstream): ${f}`);

		if (notes.length) {
			drift = true;
			console.log(`✗ ${ex.id}`);
			for (const n of notes) console.log(`    - ${n}`);
		} else {
			console.log(`✓ ${ex.id} in sync (${a.fileCount} files, `
				+ `commit ${a.sourceCommit || 'n/a'})`);
		}
	}

	if (drift) {
		console.log('\nDrift detected. If upstream is correct: re-sync src/ then '
			+ '`node tools/check-explorables-sync.js --write`.');
		process.exitCode = 1;
	} else {
		console.log('\nAll explorables in sync with their upstreams.');
	}
}

if (process.argv.includes('--write')) writeManifest();
else checkManifest();
