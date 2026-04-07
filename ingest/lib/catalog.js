/**
 * catalog.js — local angular size catalog from PixInsight CSV files
 *
 * Parses NGC-IC.csv and Messier.csv (in ingest/data/) into an in-memory Map
 * keyed by normalized object name. These CSVs are copied from PixInsight's
 * AnnotateImage script and contain angular diameters for ~98.8% of NGC/IC objects
 * and 109/110 Messier objects — covering nebulae, clusters, and galaxies.
 *
 * This is the same data pipeline used by Astrometry.net and PixInsight's own
 * annotation rendering.
 *
 * Exports:
 *   loadCatalog()     — parse both CSVs, return the combined Map
 *   lookupSize(name)  — find angular size data for a given object name
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Module-level cache: populated by loadCatalog(), reused by lookupSize().
// Map<string, { diameter: number, axisRatio: number|null, posAngle: number|null }>
let catalog = null;

/**
 * normalizeName — strip spaces between prefix and number, uppercase.
 *
 * Simbad returns "NGC 6992" with a space; the CSV uses "NGC6992" without.
 * This normalizer handles both forms so lookups match regardless of source.
 *
 * Examples:
 *   "NGC 6992"     → "NGC6992"
 *   "IC 1340"      → "IC1340"
 *   "M 42"         → "M42"
 *   "NGC6992"      → "NGC6992"  (already normalized)
 *
 * @param {string} name — object designation from Simbad or CSV
 * @returns {string} normalized uppercase name with no spaces
 */
function normalizeName(name) {
	// Collapse all whitespace, uppercase for case-insensitive matching.
	return name.replace(/\s+/g, '').toUpperCase();
}

/**
 * parseCsv — parse a PixInsight catalog CSV file into records.
 *
 * CSV format (both NGC-IC.csv and Messier.csv):
 *   id,alpha,delta,magnitude,diameter,axisRatio,posAngle,Common name,...
 *
 * The "diameter" column is the angular major axis in arcminutes.
 * "axisRatio" is major/minor axis ratio (for future ellipse rendering).
 * "posAngle" is position angle in degrees.
 *
 * @param {string} csvPath — absolute path to the CSV file
 * @returns {Array<{ id: string, diameter: number|null, axisRatio: number|null, posAngle: number|null, commonName: string }>}
 */
function parseCsv(csvPath) {
	const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
	// First line is the header row — skip it.
	const records = [];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;

		// Split on commas. The CSV does not use quoting for these fields.
		const fields = line.split(',');
		// fields[0] = id (e.g. "NGC6992", "M42")
		// fields[4] = diameter in arcminutes (may be empty)
		// fields[5] = axisRatio (may be empty)
		// fields[6] = posAngle (may be empty)
		// fields[7] = Common name (may be empty)
		const id = (fields[0] || '').trim();
		if (!id) continue;

		const diam = parseFloat(fields[4]);
		const ar   = parseFloat(fields[5]);
		const pa   = parseFloat(fields[6]);

		records.push({
			id,
			diameter:   Number.isFinite(diam) ? diam : null,
			axisRatio:  Number.isFinite(ar)   ? ar   : null,
			posAngle:   Number.isFinite(pa)   ? pa   : null,
			commonName: (fields[7] || '').trim(),
		});
	}
	return records;
}

/**
 * loadCatalog — parse NGC-IC.csv and Messier.csv into the module-level Map.
 *
 * Called once at pipeline startup. The Map is keyed by normalizeName(id).
 * Messier entries are indexed under both their "M" name and their NGC/IC
 * cross-reference (e.g. M42 → NGC1976), so lookups work from either name.
 *
 * @returns {Map} the populated catalog Map
 */
function loadCatalog() {
	if (catalog) return catalog;

	catalog = new Map();
	const dataDir = path.join(__dirname, '..', 'data');

	// Parse NGC-IC.csv first — this is the primary catalog.
	const ngcPath = path.join(dataDir, 'NGC-IC.csv');
	if (fs.existsSync(ngcPath)) {
		for (const rec of parseCsv(ngcPath)) {
			catalog.set(normalizeName(rec.id), rec);
		}
	}

	// Parse Messier.csv — add M-number aliases and fill in any gaps.
	// Messier.csv has a "NGC/IC" column (fields[8]) for cross-referencing.
	const messierPath = path.join(dataDir, 'Messier.csv');
	if (fs.existsSync(messierPath)) {
		const lines = fs.readFileSync(messierPath, 'utf8').split('\n');
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line) continue;
			const fields = line.split(',');
			const id = (fields[0] || '').trim();
			if (!id) continue;

			const diam = parseFloat(fields[4]);
			const ar   = parseFloat(fields[5]);
			const pa   = parseFloat(fields[6]);

			const rec = {
				id,
				diameter:   Number.isFinite(diam) ? diam : null,
				axisRatio:  Number.isFinite(ar)   ? ar   : null,
				posAngle:   Number.isFinite(pa)   ? pa   : null,
				commonName: (fields[7] || '').trim(),
			};

			// Index under the Messier name (e.g. "M42")
			catalog.set(normalizeName(id), rec);

			// Also index under the NGC/IC cross-reference if present.
			// This way, lookupSize("NGC 1976") finds M42's diameter.
			const ngcRef = (fields[8] || '').trim();
			if (ngcRef && !catalog.has(normalizeName(ngcRef))) {
				catalog.set(normalizeName(ngcRef), rec);
			}
		}
	}

	return catalog;
}

/**
 * lookupSize — find angular size data for a given object name.
 *
 * @param {string} name — object designation (e.g. "NGC 6992", "M 42", "IC 1340")
 * @returns {{ diameter: number, axisRatio: number|null, posAngle: number|null }|null}
 *   Returns null if the object is not in the catalog or has no diameter data.
 */
function lookupSize(name) {
	if (!catalog) loadCatalog();
	const key = normalizeName(name);
	const rec = catalog.get(key);
	if (!rec || rec.diameter === null) return null;
	return {
		diameter:  rec.diameter,
		axisRatio: rec.axisRatio,
		posAngle:  rec.posAngle,
	};
}

module.exports = { loadCatalog, lookupSize, normalizeName };
