/**
 * routes/settings.js — Settings management routes
 *
 * Handles reading and writing the operational settings (ASTAP paths, port).
 * R2 credentials are intentionally excluded from both GET and POST responses —
 * they are sensitive and should only be edited directly in config.json.
 *
 * Routes:
 *   GET  /api/settings — return current settings (without R2 creds)
 *   POST /api/settings — validate and save new settings
 */

'use strict';

const { Router } = require('express');
const path = require('path');
const { getConfig, saveConfig } = require('../lib/config');
const { resetR2Client } = require('../lib/r2');

const router = Router();

// ─── GET /settings ───────────────────────────────────────────────────────────
// Returns the current operational settings from config.json.
// R2 credentials are excluded — they should only be edited directly in config.json.
// Response: { astap_bin, astap_db_dir, port }
router.get('/settings', (req, res) => {
	const cfg = getConfig();
	res.json({
		astap_bin:    cfg.astap_bin,
		astap_db_dir: cfg.astap_db_dir,
		port:         cfg.port,
	});
});

// ─── POST /settings ──────────────────────────────────────────────────────────
// Accepts { astap_bin, astap_db_dir, port }, validates, writes to config.json,
// and updates the in-memory config for the current session.
// Port changes require a restart — the response includes restartRequired: true
// if the port value differs from what the server is currently listening on.
// Response: { ok: true, config: { ... }, restartRequired? }
router.post('/settings', (req, res) => {
	const { astap_bin, astap_db_dir, port } = req.body;

	// Validate: all three fields must be present and valid.
	// Paths must be absolute to prevent accidentally executing a relative binary
	// (e.g. "astap" would resolve to whatever's in CWD or PATH, which could be
	// surprising if the user makes a typo and saves).
	if (!astap_bin || typeof astap_bin !== 'string' || !astap_bin.trim()) {
		return res.status(400).json({ error: 'astap_bin must be a non-empty string.' });
	}
	if (!path.isAbsolute(astap_bin.trim())) {
		return res.status(400).json({ error: 'astap_bin must be an absolute path (e.g. /usr/local/bin/astap).' });
	}
	if (!astap_db_dir || typeof astap_db_dir !== 'string' || !astap_db_dir.trim()) {
		return res.status(400).json({ error: 'astap_db_dir must be a non-empty string.' });
	}
	if (!path.isAbsolute(astap_db_dir.trim())) {
		return res.status(400).json({ error: 'astap_db_dir must be an absolute path (e.g. /opt/astap).' });
	}
	if (port === undefined || port === null || port === '') {
		return res.status(400).json({ error: 'port must be provided.' });
	}
	const portNum = parseInt(port, 10);
	if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
		return res.status(400).json({ error: 'port must be a number between 1 and 65535.' });
	}

	// Check if the port changed BEFORE saving so we compare against the old value.
	const restartRequired = portNum !== getConfig().port;

	// saveConfig() merges the patch into the existing config (preserving R2
	// credentials and any other keys not in the patch), writes to config.json,
	// and updates the in-memory config for the current session.
	let newConfig;
	try {
		newConfig = saveConfig({
			astap_bin:    astap_bin.trim(),
			astap_db_dir: astap_db_dir.trim(),
			port:         portNum,
		});
	} catch (err) {
		return res.status(500).json({ error: `Could not write config.json: ${err.message}` });
	}

	// If R2 credentials may have changed (they can't via this route, but this
	// is defensive), reset the S3Client so it picks up new creds on next use.
	resetR2Client();

	// Filter R2 creds from the response — only return the non-sensitive fields.
	const response = {
		ok: true,
		config: {
			astap_bin:    newConfig.astap_bin,
			astap_db_dir: newConfig.astap_db_dir,
			port:         newConfig.port,
		},
	};
	if (restartRequired) response.restartRequired = true;
	res.json(response);
});

module.exports = router;
