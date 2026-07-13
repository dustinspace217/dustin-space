/**
 * config.js — Configuration management for the ingest server
 *
 * Handles reading and writing ingest/config.json, which stores instance-specific
 * settings like astrometry.net API key and R2 credentials. The file is gitignored.
 *
 * Exports:
 *   loadConfig()       — read config.json, merge with defaults, return object
 *   saveConfig(patch)  — merge patch into existing config, write to disk, update in-memory
 *   getConfig()        — return the current in-memory config object
 *   setConfig(obj)     — replace the in-memory config (used by saveConfig internally)
 *   CONFIG_DEFAULTS    — default values written on first run
 *   CONFIG_PATH        — absolute path to config.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Absolute path to the config file — lives alongside server.js in ingest/.
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// config.json holds the R2 secret access key and astrometry API key in
// plaintext (it's gitignored). 0600 = owner read/write only, no group/other —
// so another local account can't read the credentials. Applied on every write
// AND chmod'd on load to repair a file created before this hardening. Octal
// literal (0o600) is the POSIX permission bits fs uses for `mode`. Issue W2.
const CONFIG_MODE = 0o600;

// Default values written on first run if config.json is absent.
// The three R2 FILL_IN strings are intentional placeholders — the server
// warns at startup and uploads fail gracefully until they are replaced.
//
// Supported keys:
//   astrometry_api_key   — API key for astrometry.net (fallback plate-solver)
//   port                 — TCP port the server listens on (restart required to change)
//   r2_account_id        — Cloudflare account ID (R2 sidebar → "Account ID")
//   r2_access_key_id     — R2 API token Access Key ID
//   r2_secret_access_key — R2 API token Secret Access Key
const CONFIG_DEFAULTS = {
	astrometry_api_key:   '',
	port:                 3333,
	r2_account_id:        'FILL_IN_ACCOUNT_ID',
	r2_access_key_id:     'FILL_IN_ACCESS_KEY_ID',
	r2_secret_access_key: 'FILL_IN_SECRET_ACCESS_KEY',
};

// In-memory config — loaded once at startup via loadConfig(), updated by
// saveConfig() and setConfig(). All server code reads from this via getConfig().
let config = null;

/**
 * loadConfig — reads config.json from disk and returns a merged object.
 * If the file is missing or unreadable, defaults are written and returned.
 * Also sets the in-memory config so getConfig() works immediately.
 *
 * @returns {object} config object with all keys guaranteed present
 */
function loadConfig() {
	let raw;

	// Step 1: Try to read the file. If it doesn't exist (ENOENT),
	// create it with defaults. Any other read error is re-thrown.
	try {
		raw = fs.readFileSync(CONFIG_PATH, 'utf8');
	} catch (readErr) {
		if (readErr.code === 'ENOENT') {
			// First run — write defaults using atomic write (tmp + rename)
			// for consistency with saveConfig(). mode:0600 sets owner-only perms
			// at creation so the placeholder (and later, real) credentials are
			// never group/world-readable.
			const tmpPath = CONFIG_PATH + '.tmp';
			fs.writeFileSync(tmpPath, JSON.stringify(CONFIG_DEFAULTS, null, '\t'), { encoding: 'utf8', mode: CONFIG_MODE });
			fs.renameSync(tmpPath, CONFIG_PATH);
			config = { ...CONFIG_DEFAULTS };
			return config;
		}
		throw readErr;
	}

	// File existed and was readable — tighten its permissions to 0600 in case
	// it was created by an earlier version that didn't set a mode (or was
	// copied in with looser perms). chmod is idempotent and cheap; a failure
	// (e.g. non-owner) is logged but non-fatal so the server still starts.
	try {
		fs.chmodSync(CONFIG_PATH, CONFIG_MODE);
	} catch (chmodErr) {
		console.error(`[config] Could not chmod ${CONFIG_PATH} to 0600: ${chmodErr.message}`);
	}

	// Step 2: Parse the JSON. If it's malformed, DO NOT overwrite —
	// the file may contain valid credentials with a minor typo.
	// Log the error and fall back to defaults in memory only.
	try {
		config = Object.assign({}, CONFIG_DEFAULTS, JSON.parse(raw));
	} catch (parseErr) {
		console.error(
			`[config] config.json exists but contains invalid JSON — ` +
			`using defaults IN MEMORY ONLY. Fix the file manually to restore your settings.\n` +
			`  Parse error: ${parseErr.message}\n` +
			`  Path: ${CONFIG_PATH}`
		);
		config = { ...CONFIG_DEFAULTS };
	}

	return config;
}

/**
 * saveConfig — merges a patch object into the existing config, writes to disk,
 * and updates the in-memory config.
 *
 * This preserves keys not present in the patch (e.g. R2 credentials survive
 * when only the API key or port is updated via POST /api/settings).
 *
 * @param {object} patch — key-value pairs to merge into existing config
 * @returns {object} the new merged config
 * @throws {Error} if config.json cannot be written
 */
function saveConfig(patch) {
	// Merge the patch into the current config so unmentioned keys are preserved.
	const newConfig = { ...config, ...patch };

	// Atomic write: write to a temp file, then rename. This prevents a crash
	// mid-write from leaving config.json empty or truncated, which would
	// cause loadConfig() to lose R2 credentials on next restart.
	const tmpPath = CONFIG_PATH + '.tmp';
	fs.writeFileSync(tmpPath, JSON.stringify(newConfig, null, '\t'), { encoding: 'utf8', mode: CONFIG_MODE });
	fs.renameSync(tmpPath, CONFIG_PATH);

	config = newConfig;
	return config;
}

/**
 * getConfig — returns the current in-memory config object.
 * Call loadConfig() at startup before using this.
 *
 * @returns {object} the config object
 */
function getConfig() {
	return config;
}

/**
 * setConfig — replaces the in-memory config object.
 * Used internally by saveConfig; also available for direct mutation
 * when a module needs to update config without writing to disk.
 *
 * @param {object} obj — the new config object
 */
function setConfig(obj) {
	config = obj;
}

module.exports = {
	loadConfig,
	saveConfig,
	getConfig,
	setConfig,
	CONFIG_DEFAULTS,
	CONFIG_PATH,
};
