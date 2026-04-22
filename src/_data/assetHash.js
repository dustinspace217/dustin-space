/**
 * Cache-busting content hashes for static assets.
 *
 * Why: Cloudflare's edge cache and browsers cache CSS/JS by URL. When we
 * deploy a new version of main.css to the same URL, edge POPs that
 * already have the old version cached keep serving it until their cache
 * expires — leading to inconsistent state where reloading hits different
 * versions depending on which POP responds. Browser caches behave the
 * same way at the user level.
 *
 * Fix: hash each cache-able asset's CONTENT and append the hash as a
 * `?v=` query string in the link/script tag (see base.njk). When the
 * file content changes, the hash changes, the URL changes, and every
 * cache layer treats it as a new resource → guaranteed fresh fetch.
 * When the file is unchanged, the hash is identical, so caches stay
 * warm and there's no waste.
 *
 * Eleventy data files run at build time and the result is shared across
 * all pages in a build. So a single content hash is computed once per
 * build, embedded in every page's <link> tag.
 *
 * To add a new asset to the hash list: add a key here pointing to the
 * source-relative path, then reference `{{ assetHash.<key> }}` wherever
 * you build the URL. See the existing entries below.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Compute first 8 chars of an MD5 hash of the file's contents.
// 8 hex chars = ~4 billion possibilities, far more than enough to
// distinguish builds. MD5 is fine for cache busting (no security role).
function hashOf(relativePath) {
	const fullPath = path.join(__dirname, '..', relativePath);
	try {
		const content = fs.readFileSync(fullPath);
		return crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
	} catch (err) {
		// File missing during a partial build / typo in the path.
		// Returning a dev-marker is better than crashing the build —
		// the link still works (just no cache-bust), and the value is
		// obvious in DevTools when something's wrong.
		console.warn('[assetHash] Could not read', relativePath, '—', err.message);
		return 'missing';
	}
}

module.exports = {
	mainCss: hashOf('assets/css/main.css'),
	fontsCss: hashOf('assets/fonts/fonts.css'),
	galleryJs: hashOf('assets/js/gallery.js'),
};
