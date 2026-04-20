/**
 * routes/settings.js — Settings management routes
 *
 * Handles reading and writing the operational settings (astrometry API key, port).
 * R2 credentials are intentionally excluded from both GET and POST responses —
 * they are sensitive and should only be edited directly in config.json.
 *
 * Routes:
 *   GET  /api/settings — return current settings (without R2 creds)
 *   POST /api/settings — validate and save new settings
 */

'use strict';

const { Router } = require('express');
const { getConfig, saveConfig } = require('../lib/config');
const { resetR2Client } = require('../lib/r2');

const router = Router();

// ─── GET /settings ───────────────────────────────────────────────────────────
// Returns the current operational settings from config.json.
// R2 credentials are excluded — they should only be edited directly in config.json.
// The astrometry API key is masked (first 4 chars + dots) to avoid leaking it
// in the browser but still let the user confirm one is set.
// Response: { astrometry_api_key, port }
router.get('/settings', (req, res) => {
	const cfg = getConfig();

	// Mask the API key: show first 4 chars + dots so the user can confirm
	// which key is configured without exposing the full secret.
	const rawKey = (cfg.astrometry_api_key || '').trim();
	const maskedKey = rawKey.length > 4
		? rawKey.slice(0, 4) + '••••••••'
		: rawKey;

	res.json({
		astrometry_api_key: maskedKey,
		port:               cfg.port,
	});
});

// ─── POST /settings ──────────────────────────────────────────────────────────
// Accepts { astrometry_api_key, port }, validates, writes to config.json,
// and updates the in-memory config for the current session.
// Port changes require a restart — the response includes restartRequired: true
// if the port value differs from what the server is currently listening on.
// Response: { ok: true, config: { ... }, restartRequired? }
router.post('/settings', (req, res) => {
	const { astrometry_api_key, port } = req.body;

	// Validate port — must be present and within valid range.
	if (port === undefined || port === null || port === '') {
		return res.status(400).json({ error: 'port must be provided.' });
	}
	const portNum = parseInt(port, 10);
	if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
		return res.status(400).json({ error: 'port must be a number between 1 and 65535.' });
	}

	// Build the patch object. Only include the API key if it was actually
	// changed — a masked value (containing ••) means the user didn't edit it.
	const patch = { port: portNum };

	if (astrometry_api_key != null && typeof astrometry_api_key === 'string') {
		const trimmed = astrometry_api_key.trim();
		// Only save if the user typed a real key (not the masked placeholder).
		if (!trimmed.includes('••')) {
			patch.astrometry_api_key = trimmed;
		}
	}

	// Check if the port changed BEFORE saving so we compare against the old value.
	const restartRequired = portNum !== getConfig().port;

	// saveConfig() merges the patch into the existing config (preserving R2
	// credentials and any other keys not in the patch), writes to config.json,
	// and updates the in-memory config for the current session.
	let newConfig;
	try {
		newConfig = saveConfig(patch);
	} catch (err) {
		return res.status(500).json({ error: `Could not write config.json: ${err.message}` });
	}

	// Reset R2 client in case credentials were edited directly in config.json
	// between restarts. This is defensive — R2 creds can't change via this route.
	resetR2Client();

	// Mask the API key in the response.
	const rawKey = (newConfig.astrometry_api_key || '').trim();
	const maskedKey = rawKey.length > 4
		? rawKey.slice(0, 4) + '••••••••'
		: rawKey;

	const response = {
		ok: true,
		config: {
			astrometry_api_key: maskedKey,
			port:               newConfig.port,
		},
	};
	if (restartRequired) response.restartRequired = true;
	res.json(response);
});

module.exports = router;
