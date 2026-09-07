/**
 * Runs the real ingest pipeline and gallery writer in a temporary project.
 * Image generation and R2 are faked; git commits run only in that project.
 * This catches overwrites and staging mistakes that orchestration spies miss.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Copies the small library into a disposable project so its real __dirname
// paths stay off the working tree. Receives test cleanup and initial data;
// returns the real modules, fake R2 store, and an end-to-end job runner.
function fixture(t, initial = []) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-publish-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const lib = path.join(root, 'ingest/lib');
	fs.mkdirSync(lib, { recursive: true });
	const source = path.resolve(__dirname, '../ingest/lib');
	const files = fs.readdirSync(source).filter(name => name.endsWith('.js'));
	assert.ok(files.length <= 40, 'bound the copied library inventory');
	for (const name of files) fs.copyFileSync(path.join(source, name), path.join(lib, name));
	fs.symlinkSync(path.resolve(__dirname, '../ingest/node_modules'), path.join(root, 'ingest/node_modules'), 'dir');
	const galleryDir = path.join(root, 'src/assets/img/gallery');
	const imagesPath = path.join(root, 'src/_data/images.json');
	fs.mkdirSync(galleryDir, { recursive: true });
	fs.mkdirSync(path.dirname(imagesPath), { recursive: true });
	fs.writeFileSync(imagesPath, JSON.stringify(initial));
	const pipeline = require(path.join(lib, 'pipeline'));
	const gallery = require(path.join(lib, 'gallery'));
	const { jobs } = require(path.join(lib, 'jobs'));
	assert.equal(gallery.IMAGES_JSON, imagesPath, 'the real gallery must stay inside scratch');
	const remote = new Map();
	let sequence = 0;
	// Copy tagged bytes instead of encoding images; callers inspect every output
	// to prove one valid ingest cannot alter a previous ingest's assets.
	const generate = async (input, output) => fs.copyFileSync(input, output);
	// Runs one job using the real writer, with optional failures at DI seams.
	// Receives form fields and source bytes; returns the terminal event and trace.
	async function run(body, bytes = 'image', overrides = {}) {
		const id = `publish-${++sequence}`;
		const input = path.join(root, `${id}.jpg`);
		const tif = path.join(root, `${id}.tif`);
		fs.writeFileSync(input, bytes);
		fs.writeFileSync(tif, bytes);
		jobs.set(id, { events: [], listeners: [], status: 'running', cancelled: false });
		await pipeline.runPipeline(id, { jpg: [{ path: input }], tif: [{ path: tif }] }, {
			title: 'Nebula', date: '2026-09-04', platesolve: 'false', simbad: 'false',
			dzi: 'true', gitpush: 'false', ...body,
		}, {
			generatePreviewWebp: generate, generatePreview1200Webp: generate,
			generateThumbWebp: generate, getImageDimensions: async () => ({ width: 2400, height: 1600 }),
			run: async () => ({ stdout: '', error: null }),
			generateDzi: async (src, dest) => fs.copyFileSync(src, `${dest}.dzi`),
			uploadDziToR2: async dir => {
				const keys = fs.readdirSync(dir);
				assert.equal(keys.length, 1, 'the fake DZI generator writes one descriptor');
				for (const key of keys) remote.set(`https://tiles.dustin.space/${key}`, fs.readFileSync(path.join(dir, key), 'utf8'));
				return { uploadedKeys: keys, failed: [] };
			}, ...overrides,
		});
		const events = jobs.get(id).events.map(line => JSON.parse(line.slice(6).trim()));
		jobs.delete(id);
		const done = events.find(e => e.type === 'done');
		assert.ok(done, 'every job must emit a terminal event');
		return { ...done, events };
	}
	return { root, galleryDir, imagesPath, gallery, remote, run };
}

// Runs bounded, local git operations for the isolation test. Receives the
// scratch repository and arguments; returns stdout and throws on any failure.
// Both identity fields are test labels and contain no person's address.
function git(root, args) {
	return execFileSync('git', ['-C', root, '-c', 'user.name=Ingest Test', '-c', 'user.email=ingest-test',
		'-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', timeout: 10000 });
}

test('ingest: two variants can use v2 without changing each other’s preview, thumbnail, or DZI', async t => {
	const f = fixture(t, [{ slug: 'nebula', title: 'Nebula', variants: [
		{ id: 'hoo', revisions: [] }, { id: 'sho', revisions: [] },
	] }]);
	for (const variantId of ['hoo', 'sho']) {
		const result = await f.run({ mode: 'add-revision', parentSlug: 'nebula', parentVariantId: variantId, revisionId: 'v2' }, variantId);
		assert.equal(result.error, undefined, result.error);
	}
	const variants = f.gallery.loadGallery()[0].variants;
	for (const variant of variants) {
		const revision = variant.revisions[0];
		for (const field of ['thumbnail', 'preview_url', 'preview_1200_url']) {
			assert.equal(fs.readFileSync(path.join(f.root, 'src', revision[field]), 'utf8'), variant.id,
				`${variant.id} keeps its own ${field} bytes`);
		}
		assert.equal(f.remote.get(revision.dzi_url), variant.id, 'the uploaded DZI stays distinct too');
	}
	assert.notEqual(variants[0].revisions[0].preview_url, variants[1].revisions[0].preview_url);
	assert.notEqual(variants[0].revisions[0].dzi_url, variants[1].revisions[0].dzi_url);
});

test('ingest: ambiguous names cannot overwrite any existing output or gallery asset reference', async t => {
	// Each case has a unique target ID but aliases an existing asset namespace.
	// Missing local files still need protection when images.json references them.
	const cases = ['file', 'thumbnail', 'preview_url', 'preview_1200_url', 'dzi_url', 'annotated_dzi_url'];
	for (const field of cases) {
		await t.test(field, async sub => {
			const url = field.endsWith('dzi_url') ? 'https://tiles.dustin.space/nebula-hoo-v2.dzi'
				: `/assets/img/gallery/nebula-hoo-v2-${field === 'thumbnail' ? 'thumb' : field === 'preview_1200_url' ? 'preview-1200' : 'preview'}.webp`;
			const existing = { id: 'hoo', revisions: [{ id: 'legacy', [field === 'file' ? 'note' : field]: url }] };
			const f = fixture(sub, [{ slug: 'nebula', title: 'Nebula', variants: [existing] }]);
			const before = fs.readFileSync(f.imagesPath, 'utf8');
			const existingPath = path.join(f.galleryDir, 'nebula-hoo-v2-preview.webp');
			if (field === 'file') fs.writeFileSync(existingPath, 'original');
			const result = await f.run({ mode: 'new-target', slug: 'nebula-hoo-v2' });
			assert.match(result.error, /asset.*already|already.*asset/i);
			assert.equal(fs.readFileSync(f.imagesPath, 'utf8'), before);
			assert.equal(f.remote.size, 0, 'collision is rejected before the R2 upload');
			if (field === 'file') assert.equal(fs.readFileSync(existingPath, 'utf8'), 'original');
		});
	}
});

test('ingest: a DZI-only collision does not reject a job that writes only WebPs', async t => {
	const f = fixture(t, [{ slug: 'older', title: 'Older', variants: [{ id: 'default',
		dzi_url: 'https://tiles.dustin.space/nebula.dzi', revisions: [],
	}] }]);
	const result = await f.run({ mode: 'new-target', slug: 'nebula', dzi: 'false' });
	assert.equal(result.error, undefined, result.error);
	assert.equal(f.remote.size, 0);
});

test('ingest: rechecks asset destinations inside the gallery mutex before renaming', async t => {
	const f = fixture(t);
	const destination = path.join(f.galleryDir, 'nebula-preview.webp');
	const result = await f.run({ mode: 'new-target', slug: 'nebula', dzi: 'false' }, 'replacement', {
		addTarget: async (entry, onCommit, onRollback) => {
			// A completed writer appears after preflight but before this commit.
			fs.writeFileSync(destination, 'concurrent winner');
			return f.gallery.addTarget(entry, onCommit, onRollback);
		},
	});
	assert.match(result.error, /asset.*already|already.*asset/i);
	assert.equal(fs.readFileSync(destination, 'utf8'), 'concurrent winner');
	assert.deepEqual(f.gallery.loadGallery(), []);
});

test('ingest: one commit contains JSON and assets while unrelated staged work stays staged', async t => {
	const existingAsset = 'src/assets/img/gallery/published-preview.webp';
	const f = fixture(t, [{ slug: 'published', title: 'Published', variants: [{
		id: 'default', preview_url: existingAsset.slice(3), revisions: [],
	}] }]);
	git(f.root, ['init', '--quiet']);
	fs.writeFileSync(path.join(f.root, existingAsset), 'already published');
	fs.writeFileSync(path.join(f.root, 'unrelated.txt'), 'before');
	git(f.root, ['add', 'src/_data/images.json', existingAsset, 'unrelated.txt']);
	git(f.root, ['commit', '--quiet', '-m', 'Fixture']);
	fs.writeFileSync(path.join(f.root, 'unrelated.txt'), 'staged change');
	git(f.root, ['add', 'unrelated.txt']);
	let pushes = 0;
	const result = await f.run({ mode: 'new-target', slug: 'nebula', gitpush: 'true' }, 'new image', {
		validateBuild: async () => ({ ok: true }),
		runOrThrow: async (command, args, opts) => {
			assert.equal(command, 'git');
			assert.deepEqual(args.slice(0, 2), ['-C', f.root]);
			assert.equal(opts.timeout, args[2] === 'push' ? 120000 : 60000, 'each subprocess receives its time limit');
			if (args[2] === 'push') { pushes++; return ''; } // Never contact a remote.
			return git(f.root, args.slice(2));
		},
	});
	assert.equal(result.error, undefined, result.error);
	assert.equal(pushes, 1);
	assert.deepEqual(git(f.root, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim().split('\n'), [
		'src/_data/images.json', 'src/assets/img/gallery/nebula-preview-1200.webp',
		'src/assets/img/gallery/nebula-preview.webp', 'src/assets/img/gallery/nebula-thumb.webp',
	]);
	assert.equal(git(f.root, ['show', 'HEAD:unrelated.txt']), 'before');
	assert.equal(git(f.root, ['show', ':unrelated.txt']), 'staged change');
	assert.equal(git(f.root, ['diff', '--cached', '--name-only']).trim(), 'unrelated.txt');
});

test('ingest: refuses to publish another capture’s JSON without its uncommitted assets', async t => {
	for (const timing of ['before publishing', 'during the production build']) {
		await t.test(timing, async sub => {
			const f = fixture(sub);
			git(f.root, ['init', '--quiet']);
			fs.writeFileSync(path.join(f.root, 'unrelated.txt'), 'before');
			git(f.root, ['add', 'src/_data/images.json', 'unrelated.txt']);
			git(f.root, ['commit', '--quiet', '-m', 'Fixture']);
			const originalHead = git(f.root, ['rev-parse', 'HEAD']);
			fs.writeFileSync(path.join(f.root, 'unrelated.txt'), 'staged change');
			git(f.root, ['add', 'unrelated.txt']);
			const calls = [];
			// Capture B is deliberately local-only. Its image files exist on disk,
			// so a successful build alone cannot prove the commit will contain them.
			const saveB = async () => {
				const result = await f.run({ mode: 'new-target', slug: 'image-b', dzi: 'false' });
				assert.equal(result.error, undefined, result.error);
			};
			if (timing === 'before publishing') await saveB();
			const result = await f.run({ mode: 'new-target', slug: 'image-a', gitpush: 'true', dzi: 'false' }, 'a', {
				validateBuild: async () => {
					if (timing === 'during the production build') await saveB();
					return { ok: true };
				},
				runOrThrow: async (command, args) => {
					assert.equal(command, 'git');
					assert.deepEqual(args.slice(0, 2), ['-C', f.root]);
					calls.push(args[2]);
					if (args[2] === 'push') return ''; // Never contact a remote.
					return git(f.root, args.slice(2));
				},
			});
			assert.match(result.error, /unpublished.*assets/i);
			for (const suffix of ['thumb.webp', 'preview.webp', 'preview-1200.webp']) {
				assert.ok(result.error.includes(`src/assets/img/gallery/image-b-${suffix}`));
				assert.ok(fs.existsSync(path.join(f.galleryDir, `image-b-${suffix}`)), 'B stays available locally');
			}
			assert.equal(git(f.root, ['rev-parse', 'HEAD']), originalHead, 'refusal makes no commit');
			assert.deepEqual(calls, ['ls-tree'], 'refusal precedes git add, commit, and push');
			assert.equal(git(f.root, ['diff', '--cached', '--name-only']).trim(), 'unrelated.txt');
			assert.equal(git(f.root, ['show', ':unrelated.txt']), 'staged change');
			assert.deepEqual(f.gallery.loadGallery().map(target => target.slug).sort(), ['image-a', 'image-b']);
		});
	}
});

test('ingest: a writer waits through commit but finishes during a stalled push', { timeout: 5000 }, async t => {
	const f = fixture(t);
	git(f.root, ['init', '--quiet']);
	git(f.root, ['add', 'src/_data/images.json']);
	git(f.root, ['commit', '--quiet', '-m', 'Fixture']);
	let writer;
	let pushes = 0;
	let finishPush, startedPush;
	const pendingPush = new Promise(resolve => { finishPush = resolve; });
	const atPush = new Promise(resolve => { startedPush = resolve; });
	const publishing = f.run({ mode: 'new-target', slug: 'image-a', gitpush: 'true', dzi: 'false' }, 'a', {
		validateBuild: async () => ({ ok: true }),
		runOrThrow: async (command, args, opts) => {
			assert.equal(command, 'git');
			assert.deepEqual(args.slice(0, 2), ['-C', f.root]);
			if (args[2] === 'ls-tree') {
				let queued;
				const atWrite = new Promise(resolve => { queued = resolve; });
				writer = f.run({ mode: 'new-target', slug: 'image-b', dzi: 'false' }, 'b', {
					addTarget: (entry, onCommit, onRollback) => {
						const pending = f.gallery.addTarget(entry, onCommit, onRollback);
						queued();
						return pending;
					},
				});
				await atWrite;
			}
			if (args[2] === 'commit') {
				assert.deepEqual(JSON.parse(fs.readFileSync(f.imagesPath, 'utf8')).map(target => target.slug), ['image-a'],
					'the queued writer cannot change the JSON being committed');
			}
			if (args[2] === 'push') {
				pushes++;
				assert.equal(opts.timeout, 120000);
				startedPush();
				await pendingPush;
				throw Object.assign(new Error('git push ETIMEDOUT'), { code: 'ETIMEDOUT', killed: true });
			}
			return git(f.root, args.slice(2));
		},
	});
	try {
		await atPush;
		assert.ok(writer, 'the second writer reached the mutex');
		assert.equal((await writer).error, undefined, 'the writer finishes before push is released');
		assert.deepEqual(f.gallery.loadGallery().map(target => target.slug), ['image-b', 'image-a']);
	} finally {
		finishPush();
	}
	const result = await publishing;
	assert.equal(result.error, undefined, 'a failed push keeps the successful local commit');
	assert.ok(result.events.some(event => event.type === 'warn' && /Git push failed:.*ETIMEDOUT.*commit is local/s.test(event.message)));
	assert.equal(pushes, 1);
	assert.deepEqual(JSON.parse(git(f.root, ['show', 'HEAD:src/_data/images.json'])).map(target => target.slug), ['image-a']);
});

test('ingest: a timed-out local git command releases the mutex for the next writer', { timeout: 5000 }, async t => {
	const f = fixture(t);
	git(f.root, ['init', '--quiet']);
	git(f.root, ['add', 'src/_data/images.json']);
	git(f.root, ['commit', '--quiet', '-m', 'Fixture']);
	const originalHead = git(f.root, ['rev-parse', 'HEAD']);
	const calls = [];
	const failed = await f.run({ mode: 'new-target', slug: 'image-a', gitpush: 'true', dzi: 'false' }, 'a', {
		validateBuild: async () => ({ ok: true }),
		runOrThrow: async (command, args, opts) => {
			assert.equal(command, 'git');
			assert.deepEqual(args.slice(0, 2), ['-C', f.root]);
			assert.equal(opts.timeout, 60000);
			calls.push(args[2]);
			if (args[2] === 'commit') throw Object.assign(new Error('git commit ETIMEDOUT'), { code: 'ETIMEDOUT', killed: true });
			return git(f.root, args.slice(2));
		},
	});
	assert.match(failed.error, /git commit ETIMEDOUT/);
	assert.deepEqual(calls, ['ls-tree', 'add', 'commit'], 'a timed-out commit must never push');
	assert.equal(git(f.root, ['rev-parse', 'HEAD']), originalHead);
	const next = await f.run({ mode: 'new-target', slug: 'image-b', dzi: 'false' });
	assert.equal(next.error, undefined, 'a rejected mutex operation must not stall later writes');
	assert.deepEqual(f.gallery.loadGallery().map(target => target.slug), ['image-b', 'image-a']);
});
