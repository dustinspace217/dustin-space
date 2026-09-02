'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');
const { loadConfig, parseArgs } = require('../../now-imaging/agent');

/**
 * writeConfig — put a config.json in a fresh temp dir and return its path.
 * Receives the object to serialize; returns the file path. A fresh directory
 * per call is what makes the relative-path resolution assertions meaningful.
 */
function writeConfig(obj) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cfg-'));
	const file = path.join(dir, 'config.json');
	fs.writeFileSync(file, JSON.stringify(obj));
	return file;
}

// Minimum viable production config: R2 credentials present, everything else default.
const CREDS = { r2AccountId: 'acct', r2AccessKeyId: 'key', r2SecretAccessKey: 'secret' };

test('loadConfig: defaults fill in, and relative paths resolve against the config directory', () => {
	const file = writeConfig(CREDS);
	const cfg = loadConfig(file);
	// 0.2 is the pinned default: a live probe measured scale 0.4 at 2501 px / 675 KB
	// for this camera, which is more than the card needs on every sub.
	assert.equal(cfg.imageScale, 0.2);
	assert.equal(cfg.jpegQuality, 80);
	assert.equal(cfg.heartbeatSeconds, 300);
	assert.equal(cfg.ninaBaseUrl, 'http://localhost:1888');
	assert.equal(cfg.dryRunDir, null);
	// Not the process CWD: a Scheduled Task starts somewhere else entirely.
	assert.equal(cfg.statePath, path.join(path.dirname(file), 'state.json'));
	assert.equal(cfg.logPath, path.join(path.dirname(file), 'now-imaging.log'));
	assert.equal(cfg.resolveCachePath, path.join(path.dirname(file), 'resolve-cache.json'));
});

test('loadConfig: values in the file win over the defaults', () => {
	const file = writeConfig(Object.assign({ imageScale: 0.5, jpegQuality: 60, heartbeatSeconds: 30 }, CREDS));
	const cfg = loadConfig(file);
	assert.equal(cfg.imageScale, 0.5);
	assert.equal(cfg.jpegQuality, 60);
	assert.equal(cfg.heartbeatSeconds, 30);        // exactly at the floor is allowed
});

test('loadConfig: the three R2 keys are required for a real run', () => {
	// Each missing key is named on its own, so the operator fixes one and sees the next.
	assert.throws(() => loadConfig(writeConfig({})), /config\.r2AccountId is missing/);
	assert.throws(() => loadConfig(writeConfig({ r2AccountId: 'acct' })), /config\.r2AccessKeyId is missing/);
	assert.throws(() => loadConfig(writeConfig({ r2AccountId: 'acct', r2AccessKeyId: 'key' })), /config\.r2SecretAccessKey is missing/);
	// The example file ships literal "REPLACE" placeholders; those must not count as set.
	assert.throws(() => loadConfig(writeConfig({ r2AccountId: 'REPLACE', r2AccessKeyId: 'k', r2SecretAccessKey: 's' })), /config\.r2AccountId is missing/);
});

test('loadConfig: dryRunDir skips the R2 credential checks entirely', () => {
	const file = writeConfig({ dryRunDir: 'out' });
	const cfg = loadConfig(file);
	assert.equal(cfg.dryRunDir, path.join(path.dirname(file), 'out'));
	assert.equal(cfg.r2AccountId, undefined);
});

test('loadConfig: --dry-run supplies dryRunDir as a fallback, and the file still wins', () => {
	// This is the path the dry-run verification actually takes: a config.json copied
	// from the example still holds "REPLACE", so the flag has to be visible to the
	// credential check, not applied after it.
	const placeholders = writeConfig({ r2AccountId: 'REPLACE', r2AccessKeyId: 'REPLACE', r2SecretAccessKey: 'REPLACE' });
	const cfg = loadConfig(placeholders, { dryRunDir: '/tmp/agent-dry-run' });
	assert.equal(cfg.dryRunDir, '/tmp/agent-dry-run');

	const explicit = writeConfig({ dryRunDir: 'from-file' });
	const cfg2 = loadConfig(explicit, { dryRunDir: '/tmp/agent-dry-run' });
	assert.equal(cfg2.dryRunDir, path.join(path.dirname(explicit), 'from-file'));
});

test('loadConfig: imageScale outside (0, 1] is rejected, and the message names the key', () => {
	// '0.5' is in the list on purpose: it coerces through `x > 0 && x <= 1` and
	// would pass startup, then make lib/nina.js throw a TypeError on every frame.
	for (const bad of [0, -1, 1.5, 'big', '0.5', null]) {
		assert.throws(() => loadConfig(writeConfig(Object.assign({ imageScale: bad }, CREDS))), /config\.imageScale/);
	}
});

test('loadConfig: jpegQuality must be an integer 1-100', () => {
	// Non-integers are rejected too: lib/nina.js throws TypeError on one, which would
	// otherwise be a failure on every frame all night instead of once at startup.
	// '80' is a numeric STRING — Number.isInteger already refuses it.
	for (const bad of [0, 101, 80.5, 'high', '80', null]) {
		assert.throws(() => loadConfig(writeConfig(Object.assign({ jpegQuality: bad }, CREDS))), /config\.jpegQuality/);
	}
});

test('loadConfig: heartbeatSeconds below the floor is rejected', () => {
	// '300' is above the floor but still a string; it must not coerce through.
	for (const bad of [29, 0, -5, 'often', '300', null]) {
		assert.throws(() => loadConfig(writeConfig(Object.assign({ heartbeatSeconds: bad }, CREDS))), /config\.heartbeatSeconds/);
	}
});

test('loadConfig: publicBaseUrl must be an https origin', () => {
	// This is the config-reachable path to a document validateStatus refuses. An
	// http:// origin builds a frame.url the publish gate rejects — and before this
	// check existed that rejection landed AFTER both uploads, leaving state.json
	// unsaved so every heartbeat re-uploaded the same frame and a status.json
	// carrying the bad URL. Rejecting at startup is what makes that unreachable.
	for (const bad of ['http://live.dustin.space', 'live.dustin.space', 'https://', 'ftp://x', '', null, 42]) {
		assert.throws(
			() => loadConfig(writeConfig(Object.assign({ publicBaseUrl: bad }, CREDS))),
			/config\.publicBaseUrl/,
			`expected ${JSON.stringify(bad)} to be rejected`,
		);
	}
	// The default and an explicit https value both survive.
	assert.equal(loadConfig(writeConfig(CREDS)).publicBaseUrl, 'https://live.dustin.space');
	assert.equal(
		loadConfig(writeConfig(Object.assign({ publicBaseUrl: 'https://cdn.example.com/' }, CREDS))).publicBaseUrl,
		'https://cdn.example.com/',
	);
});

test('parseArgs: flags, the default config path, and --config without a value', () => {
	const d = parseArgs([]);
	assert.equal(d.dryRun, false);
	assert.equal(d.once, false);
	assert.equal(path.basename(d.configPath), 'config.json');

	const a = parseArgs(['--dry-run', '--once', '--config', '/etc/x.json']);
	assert.equal(a.dryRun, true);
	assert.equal(a.once, true);
	assert.equal(a.configPath, '/etc/x.json');

	// A dangling --config would otherwise hand `undefined` to readFileSync.
	assert.throws(() => parseArgs(['--config']), /--config needs a path/);
	assert.throws(() => parseArgs(['--config', '--once']), /--config needs a path/);
});
