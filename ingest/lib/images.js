/**
 * images.js — vips image-processing wrappers for the ingest pipeline
 *
 * Wraps libvips CLI calls for the three image operations the pipeline needs:
 *   1. Generate preview WebP (2400px wide, Q=82) from a JPG
 *   2. Generate thumbnail WebP (600px wide, Q=80) from a JPG
 *   3. Generate DZI (Deep Zoom Image) tile tree from a TIF
 *   4. Read image pixel dimensions (width × height)
 *
 * All calls go through runOrThrow() from lib/exec.js, which uses execFile
 * (no shell) — so file paths with special characters are safe.
 *
 * vips is the CLI frontend for libvips, a fast image processing library.
 * It processes images in streaming/tiled fashion, so even multi-GB TIFs
 * don't require the whole file in memory.
 *
 * Exports:
 *   generatePreviewWebp(jpgPath, outputPath)      — 2400px preview
 *   generateThumbWebp(jpgPath, outputPath)         — 600px thumbnail
 *   generateDzi(tifPath, outputBase, opts)         — DZI tile tree
 *   getImageDimensions(imagePath)                  — { width, height }
 */

'use strict';

const { runOrThrow } = require('./exec');

/**
 * generatePreviewWebp — create a 2400px-wide WebP preview from a JPG.
 *
 * Uses vips thumbnail, which handles orientation, colour management,
 * and shrink-on-load (reads only the pixels needed for the target size).
 *
 * @param {string} jpgPath    — absolute path to the source JPG
 * @param {string} outputPath — absolute path for the output WebP
 *   (e.g. /path/to/gallery/slug-preview.webp)
 * @returns {Promise<string>} stdout from vips (usually empty on success)
 *
 * vips thumbnail args:
 *   [Q=82]     — WebP quality 82 (good balance of size vs. detail)
 *   2400       — target width in pixels
 *   --size down — only shrink, never upscale (if source < 2400px, keep original width)
 */
async function generatePreviewWebp(jpgPath, outputPath) {
	return runOrThrow(
		'vips', ['thumbnail', jpgPath, `${outputPath}[Q=82]`, '2400', '--size', 'down']
	);
}

/**
 * generateThumbWebp — create a 600px-wide WebP thumbnail from a JPG.
 *
 * Same approach as generatePreviewWebp but smaller and slightly lower quality.
 *
 * @param {string} jpgPath    — absolute path to the source JPG
 * @param {string} outputPath — absolute path for the output WebP
 *   (e.g. /path/to/gallery/slug-thumb.webp)
 * @returns {Promise<string>} stdout from vips
 *
 * vips thumbnail args:
 *   [Q=80]     — WebP quality 80 (slightly more compression for thumbnails)
 *   600        — target width in pixels
 *   --size down — never upscale
 */
async function generateThumbWebp(jpgPath, outputPath) {
	return runOrThrow(
		'vips', ['thumbnail', jpgPath, `${outputPath}[Q=80]`, '600', '--size', 'down']
	);
}

/**
 * generateDzi — create a DZI (Deep Zoom Image) tile tree from a TIF.
 *
 * DZI is the tile format consumed by OpenSeadragon. vips dzsave creates:
 *   {outputBase}.dzi        — XML descriptor (tile size, overlap, dimensions)
 *   {outputBase}_files/     — directory tree of JPEG tile images
 *
 * @param {string} tifPath    — absolute path to the source TIF
 * @param {string} outputBase — base path for output (without .dzi extension).
 *   vips appends .dzi and _files/ automatically.
 *   e.g. /tmp/ingest-<id>/dzi/horsehead → horsehead.dzi + horsehead_files/
 * @param {object} [opts]     — optional overrides
 * @param {number} [opts.timeout=1200000] — timeout in ms (default 20 minutes;
 *   large TIFs can take several minutes to tile)
 * @returns {Promise<string>} stdout from vips
 *
 * vips dzsave args:
 *   --tile-size 256   — standard OpenSeadragon tile size
 *   --overlap 1       — 1-pixel overlap between tiles (OSD default)
 *   --depth onepixel  — include a 1×1 pixel tile at the top of the pyramid
 *   --suffix .jpg[Q=90] — JPEG tiles at quality 90
 */
async function generateDzi(tifPath, outputBase, opts = {}) {
	const timeout = opts.timeout || 20 * 60 * 1000; // 20 min default
	return runOrThrow(
		'vips',
		['dzsave', tifPath, outputBase,
			'--tile-size', '256', '--overlap', '1',
			'--depth', 'onepixel', '--suffix', '.jpg[Q=90]'],
		{ timeout }
	);
}

/**
 * getImageDimensions — read the pixel width and height of an image file.
 *
 * Uses `vips header` which reads only the image header, not the full pixel data.
 * Works with JPG, TIF, WebP, PNG, and any other format vips supports.
 *
 * @param {string} imagePath — absolute path to the image file
 * @returns {Promise<{width: number|null, height: number|null}>}
 *   Returns { width, height } in pixels, or { width: null, height: null }
 *   if vips can't read the file or parse the output.
 */
async function getImageDimensions(imagePath) {
	try {
		const dimOut = await runOrThrow('vips', ['header', imagePath]);
		const wMatch = dimOut.match(/width:\s*(\d+)/);
		const hMatch = dimOut.match(/height:\s*(\d+)/);
		return {
			width:  wMatch ? parseInt(wMatch[1]) : null,
			height: hMatch ? parseInt(hMatch[1]) : null,
		};
	} catch {
		// vips couldn't read the file — return nulls so callers can fall back.
		return { width: null, height: null };
	}
}

module.exports = { generatePreviewWebp, generateThumbWebp, generateDzi, getImageDimensions };
