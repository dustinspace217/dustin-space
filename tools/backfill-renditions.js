/**
 * tools/backfill-renditions.js — one-shot backfill for the W6 detail-hero srcset
 *
 * The ingest pipeline (ingest/lib/pipeline.js) now generates a 1200px preview
 * rendition and persists the 2400px preview's real pixel dimensions
 * (preview_1200_url / preview_width / preview_height) on every NEW entry. The
 * gallery's EXISTING entries predate that change and carry none of those fields,
 * so the detail hero can't build its srcset or reserve exact space for them —
 * exactly the layout shift (CLS) the W6 work exists to kill.
 *
 * This script closes that gap for the images already in src/_data/images.json:
 *   1. Walk every target → variant (and each variant's revisions[]) in document
 *      order, matching each object to its "preview_url" line in the raw file text.
 *   2. For any object whose preview_url points to a LOCAL
 *      /assets/img/gallery/<name>-preview.webp that exists on disk:
 *        - generate <name>-preview-1200.webp from that 2400px preview (downscale)
 *          if it isn't already present;
 *        - read the REAL dimensions of the 2400px preview;
 *        - INSERT the three fields as text immediately after that preview_url
 *          line, copying its exact indentation.
 *   3. Write images.json back atomically (temp + rename).
 *
 * Why textual insertion instead of JSON.parse → JSON.stringify: the committed
 * images.json uses a non-standard indentation (array-of-object elements are
 * indented one extra level) that JSON.stringify(data, null, '\t') does NOT
 * reproduce — a full re-serialize would reformat the entire file (~300 lines of
 * pure-whitespace churn) for a 42-line data addition. Inserting the new lines in
 * place keeps the diff to exactly what changed. The pipeline's own writeGallery()
 * canonicalizes the format on its next real write; that reformat belongs to that
 * commit, not to this backfill.
 *
 * Matching is positional: the parsed structure is walked depth-first (each
 * variant, then its revisions), producing the objects that own a preview_url in
 * the SAME order those "preview_url" lines appear in the text — because both
 * derive from the identical JSON key/array order. A count mismatch aborts loudly
 * rather than risk inserting fields onto the wrong object.
 *
 * Other design choices:
 *   - Source is the EXISTING 2400px preview.webp, not the original TIF/JPG (the
 *     masters aren't in the repo); downscaling 2400→1200 with vips --size down is
 *     visually indistinguishable at the srcset's mobile widths.
 *   - LOUD fail: if a preview file exists but its dimensions can't be read, the
 *     script throws rather than writing null dims (a null would silently
 *     reintroduce the CLS this backfill removes — same rule the pipeline enforces).
 *   - Data-preserving: images.json is copied to a timestamped .bak OUTSIDE the
 *     repo before the write, per the workspace "back up before you mutate" rule.
 *   - Idempotent: re-running skips objects that already have preview_1200_url and
 *     skips the vips step when the 1200 file already exists.
 *
 * Run: node tools/backfill-renditions.js   (or: bounded-run node tools/backfill-renditions.js)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Reuse the pipeline's own image helpers so the backfill produces byte-for-byte
// the same rendition an ingest run would, and its dimension read matches too.
const { generatePreview1200Webp, getImageDimensions } = require('../ingest/lib/images');

// Repo root is one level up from tools/. images.json and the gallery image dir
// are resolved from there so the script works regardless of the cwd it's run from.
const PROJECT_ROOT = path.resolve(__dirname, '..');
const IMAGES_JSON  = path.join(PROJECT_ROOT, 'src', '_data', 'images.json');
const GALLERY_DIR  = path.join(PROJECT_ROOT, 'src', 'assets', 'img', 'gallery');

// The public URL prefix every local gallery preview uses. A preview_url that
// doesn't start with this (null, or an off-site URL) has no local file to
// measure or downscale, so it's carried in the walk but never backfilled.
const LOCAL_PREFIX = '/assets/img/gallery/';

/**
 * collectPreviewObjects — depth-first list of every object that OWNS a
 * preview_url property, in document order (variant, then each of its revisions).
 * This order matches the sequence of "preview_url" lines in the raw text.
 *
 * @param {Array} data — the parsed images.json array
 * @returns {object[]} the preview-bearing objects, in text order
 */
function collectPreviewObjects(data) {
	const out = [];
	// Bounded by the in-memory array lengths — naturally finite. Power-of-Ten rule 2.
	for (const target of data) {
		if (!target || !Array.isArray(target.variants)) continue;
		for (const variant of target.variants) {
			if (variant && Object.prototype.hasOwnProperty.call(variant, 'preview_url')) out.push(variant);
			if (variant && Array.isArray(variant.revisions)) {
				for (const rev of variant.revisions) {
					if (rev && Object.prototype.hasOwnProperty.call(rev, 'preview_url')) out.push(rev);
				}
			}
		}
	}
	return out;
}

/**
 * renditionFor — ensure the 1200px file exists and read the 2400px dimensions
 * for one preview-bearing object. Returns the field values to insert, or null
 * when the object isn't backfillable (non-local URL, missing file, already done).
 *
 * @param {object} obj — a variant or revision that owns a preview_url
 * @param {string} label — human-readable location for log lines
 * @param {string[]} generated — accumulator of newly-created 1200 basenames
 * @returns {Promise<{url:string,width:number,height:number}|null>}
 */
async function renditionFor(obj, label, generated) {
	const url = obj.preview_url;
	if (typeof url !== 'string' || !url.startsWith(LOCAL_PREFIX)) return null;      // null / off-site
	if (Object.prototype.hasOwnProperty.call(obj, 'preview_1200_url')) {            // already backfilled
		console.log(`  · ${label}: already has preview_1200_url — skipped.`);
		return null;
	}

	const previewName = path.basename(url);                       // e.g. veil-nebula-preview.webp
	const previewPath = path.join(GALLERY_DIR, previewName);
	if (!fs.existsSync(previewPath)) {
		console.warn(`  ! ${label}: preview file missing on disk (${previewName}) — skipped.`);
		return null;
	}

	const preview1200Name = previewName.replace(/-preview\.webp$/, '-preview-1200.webp');
	const preview1200Path = path.join(GALLERY_DIR, preview1200Name);
	if (!fs.existsSync(preview1200Path)) {
		await generatePreview1200Webp(previewPath, preview1200Path);   // downscale from the 2400px master
		generated.push(preview1200Name);
	}

	const dims = await getImageDimensions(previewPath);
	if (!dims.width || !dims.height) {
		throw new Error(`Could not read dimensions of ${previewName} — refusing to write null dims (would reintroduce hero layout shift).`);
	}

	console.log(`  ✓ ${label}: ${dims.width}×${dims.height}, 1200 → ${preview1200Name}`);
	return { url: `${LOCAL_PREFIX}${preview1200Name}`, width: dims.width, height: dims.height };
}

/**
 * main — run the backfill end to end.
 */
async function main() {
	console.log('Backfilling W6 detail-hero renditions into images.json...\n');

	const raw  = fs.readFileSync(IMAGES_JSON, 'utf8');
	const data = JSON.parse(raw);
	if (!Array.isArray(data)) throw new Error('images.json root is not an array — aborting.');

	const objects = collectPreviewObjects(data);
	const lines   = raw.split('\n');

	// Index every text line that declares a preview_url, capturing its exact
	// leading indentation so inserted fields line up. These lines, in order, map
	// 1:1 onto `objects` (same JSON key/array order). A mismatch is a fatal
	// assumption break — abort rather than insert onto the wrong object.
	const previewLineRe = /^(\s*)"preview_url":/;
	const previewLineIdx = [];
	for (let i = 0; i < lines.length; i++) {
		if (previewLineRe.test(lines[i])) previewLineIdx.push(i);
	}
	if (previewLineIdx.length !== objects.length) {
		throw new Error(`preview_url line count (${previewLineIdx.length}) != preview-bearing object count (${objects.length}) — refusing to guess the mapping.`);
	}

	// Compute the insertions (generating 1200 files + reading dims as needed),
	// keyed by the text line index to insert AFTER. Done before touching the text
	// so a failure aborts with the file untouched.
	const generated = [];
	const inserts = new Map();   // lineIndex → array of new text lines
	let modified = 0;
	for (let k = 0; k < objects.length; k++) {
		const obj = objects[k];
		const label = obj.id ? `id ${obj.id}` : `preview #${k}`;
		const rend = await renditionFor(obj, label, generated);
		if (!rend) continue;
		const indent = previewLineRe.exec(lines[previewLineIdx[k]])[1];
		inserts.set(previewLineIdx[k], [
			`${indent}"preview_1200_url": ${JSON.stringify(rend.url)},`,
			`${indent}"preview_width": ${rend.width},`,
			`${indent}"preview_height": ${rend.height},`,
		]);
		modified++;
	}

	if (modified === 0) {
		console.log('\nNothing to backfill — every local preview already has its rendition fields.');
		return;
	}

	// Rebuild the file text, splicing each object's new lines in right after its
	// preview_url line. All other bytes are preserved exactly.
	const outLines = [];
	for (let i = 0; i < lines.length; i++) {
		outLines.push(lines[i]);
		if (inserts.has(i)) outLines.push(...inserts.get(i));
	}
	const outText = outLines.join('\n');

	// Sanity: the result must still parse (guards against a malformed splice).
	JSON.parse(outText);

	// Data-preserving: back up the current images.json to the OUTSIDE-of-repo
	// artifacts sibling (never src/_data, so a stray .bak can't be git-committed).
	const backupDir = path.join(PROJECT_ROOT, '..', 'dustin-space-artifacts', 'backfill-backups');
	fs.mkdirSync(backupDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupPath = path.join(backupDir, `images.json.${stamp}.bak`);
	fs.copyFileSync(IMAGES_JSON, backupPath);

	// Atomic write (temp + rename).
	const tmpPath = `${IMAGES_JSON}.tmp`;
	fs.writeFileSync(tmpPath, outText, 'utf8');
	fs.renameSync(tmpPath, IMAGES_JSON);

	console.log(`\nDone. Objects updated: ${modified}. New 1200 renditions: ${generated.length}.`);
	console.log(`Backup written: ${path.basename(backupPath)}`);
	if (generated.length) console.log(`Generated: ${generated.join(', ')}`);
}

main().catch(err => {
	console.error(`\nBackfill FAILED: ${err.message}`);
	process.exit(1);
});
