#!/usr/bin/env node
/**
 * agent.js — the "Currently imaging" publisher (spec §5).
 *
 * Runs forever on the MeLe as a Scheduled Task. Sleeps until NINA's WebSocket
 * says an image was saved (or a 5-minute heartbeat fires), then: read history →
 * newest LIGHT → if new, fetch its JPEG by index, read the camera's exposure
 * end time, resolve the target name, build + validate status, publish to R2,
 * persist state. Every failure is logged and retried on the next trigger; the
 * process never exits on its own.
 *
 * Flags: --dry-run (write to ./dry-run/ instead of R2), --config <path>,
 * --once (one check() then exit; used by the dry-run verification task).
 */
'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { S3Client } = require('@aws-sdk/client-s3');

const { createNina, jpegDimensions }     = require('./lib/nina');
const { selectLatestLight, countSubsTonight, nextFrameExpectedAt } = require('./lib/select');
const { createResolver }                 = require('./lib/resolve');
const { buildStatus, validateStatus }    = require('./lib/status');
const { createPublisher, keyForFrame, MAX_PENDING_DELETE } = require('./lib/publish');
const { createState }                    = require('./lib/state');
const { createLogger }                   = require('./lib/log');
const { createDebouncer, createReconnector } = require('./lib/backoff');

// Consecutive check() failures before an extra "failing repeatedly" warning.
const REPEAT_WARN_AFTER = 5;
// Socket events are debounced this long so a burst becomes one check().
const DEBOUNCE_MS = 2000;
// Floor for heartbeatSeconds. Below this the heartbeat stops being a safety net
// and becomes a poller: every tick costs a NINA history round-trip, and the
// socket already covers the normal path.
const MIN_HEARTBEAT_SECONDS = 30;

/**
 * readOverrides — load overrides.json from beside this file.
 * Receives nothing; returns the parsed object. Throws with the path named on a
 * missing or malformed file: an empty overrides map is not a safe fallback
 * (it would silently publish "Diabolo Nebula" for M 27, see README), and this
 * runs at startup where an operator is present to read the error.
 */
function readOverrides() {
	const file = path.join(__dirname, 'overrides.json');
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (err) {
		throw new Error(`cannot read ${file}: ${err.message}`);
	}
}

/**
 * loadConfig — receives a path and optional CLI overrides; returns the parsed
 * config with defaults applied, or throws a message naming the offending key.
 * Read once at startup.
 *
 * cliOverrides currently carries only dryRunDir, and only as a FALLBACK: a
 * dryRunDir in config.json wins. It exists because `--dry-run` has to be known
 * BEFORE the R2-credential check below — otherwise a config.json still holding
 * the example's "REPLACE" placeholders throws on a run that was never going to
 * touch R2, which is exactly how the dry-run verification is done.
 *
 * Relative logPath/statePath/resolveCachePath are resolved against the CONFIG
 * file's directory, not the process CWD: a Scheduled Task does not necessarily
 * start in this folder, and a state file written wherever it happened to start
 * would be found by nothing.
 */
function loadConfig(configPath, cliOverrides = {}) {
	const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
	const cfg = Object.assign({
		ninaBaseUrl: 'http://localhost:1888', r2Bucket: 'dustinspace-live', publicBaseUrl: 'https://live.dustin.space',
		imageScale: 0.2, jpegQuality: 80, heartbeatSeconds: 300, dryRunDir: null,
		logPath: 'now-imaging.log', statePath: 'state.json', resolveCachePath: 'resolve-cache.json',
	}, raw);
	if (!cfg.dryRunDir && cliOverrides.dryRunDir) cfg.dryRunDir = cliOverrides.dryRunDir;
	const dir = path.dirname(configPath);
	for (const k of ['logPath', 'statePath', 'resolveCachePath']) cfg[k] = path.resolve(dir, cfg[k]);
	if (cfg.dryRunDir) cfg.dryRunDir = path.resolve(dir, cfg.dryRunDir);

	// Each numeric check pairs an explicit `typeof === 'number'` with a NEGATED
	// positive assertion (`!(x > 0 …)`). The typeof rejects a STRING that would
	// otherwise coerce through the comparison ("0.5" > 0 is true), which passes
	// startup and then makes lib/nina.js throw a TypeError on every frame all
	// night. The negated form rejects null and NaN, since every comparison
	// against NaN is false and `x <= 0` alone would wave them through.
	if (typeof cfg.imageScale !== 'number' || !(cfg.imageScale > 0 && cfg.imageScale <= 1)) {
		throw new Error('config.imageScale must be a number in (0, 1]');
	}
	// Integer 1-100 mirrors lib/nina.js's own contract for the quality argument.
	// Number.isInteger is already a type check — it is false for "80" — so this
	// line needs no separate typeof. Rejecting here means an out-of-range value is
	// a startup failure the operator sees once, not a TypeError on every frame.
	if (!(Number.isInteger(cfg.jpegQuality) && cfg.jpegQuality >= 1 && cfg.jpegQuality <= 100)) {
		throw new Error('config.jpegQuality must be an integer 1-100');
	}
	if (typeof cfg.heartbeatSeconds !== 'number' || !(cfg.heartbeatSeconds >= MIN_HEARTBEAT_SECONDS)) {
		throw new Error(`config.heartbeatSeconds must be a number of at least ${MIN_HEARTBEAT_SECONDS}`);
	}
	// https is not cosmetic here: validateStatus refuses any frame.url that is not
	// https, so an http:// (or trailing-garbage) origin builds a document the
	// publish gate will reject. Caught at startup, that is one error message;
	// caught at publish time it was a rejection AFTER both uploads, which left the
	// state unsaved and re-published the same frame on every heartbeat.
	if (typeof cfg.publicBaseUrl !== 'string' || !/^https:\/\/.+/.test(cfg.publicBaseUrl)) {
		throw new Error('config.publicBaseUrl must be an https:// URL');
	}
	if (!cfg.dryRunDir) {
		for (const k of ['r2AccountId', 'r2AccessKeyId', 'r2SecretAccessKey']) {
			if (!cfg[k] || cfg[k] === 'REPLACE') throw new Error(`config.${k} is missing (set it, or use dryRunDir/--dry-run)`);
		}
	}
	return cfg;
}

/**
 * runAgent — wires everything and starts the loop. Receives {cfg, once, deps}
 * where deps lets tests inject nina/publisher/state/log/resolver; returns a
 * stop(). With once:true it performs exactly one check() and starts neither the
 * socket nor the heartbeat, so the returned stop() has nothing to tear down.
 */
async function runAgent({ cfg, once = false, deps = {} }) {
	const log = deps.log || createLogger(cfg.logPath);
	const nina = deps.nina || createNina({ baseUrl: cfg.ninaBaseUrl });
	const state = deps.state || createState(cfg.statePath);
	const resolver = deps.resolver || createResolver({
		overrides: readOverrides(),
		cachePath: cfg.resolveCachePath,
	});
	const publisher = deps.publisher || createPublisher({
		// In dry-run mode no S3 client is constructed at all: the credentials are
		// unvalidated placeholders there, and publish() never reaches s3.send().
		s3: cfg.dryRunDir ? null : new S3Client({
			endpoint: `https://${cfg.r2AccountId}.r2.cloudflarestorage.com`, region: 'auto',
			credentials: { accessKeyId: cfg.r2AccessKeyId, secretAccessKey: cfg.r2SecretAccessKey },
		}),
		bucket: cfg.r2Bucket, publicBaseUrl: cfg.publicBaseUrl, dryRunDir: cfg.dryRunDir,
	});

	// Trailing slashes trimmed the same way lib/publish.js trims them, so the URL
	// built below is character-for-character the one publish() will write.
	const publicBase = String(cfg.publicBaseUrl).replace(/\/+$/, '');

	let failures = 0;
	let running = false;
	// Set when a trigger arrives while a check is already in flight, consumed in
	// the finally below. Without it an IMAGE-SAVE landing during a slow check is
	// discarded outright and that sub waits for the next heartbeat — up to five
	// minutes of a stale card. One deferred re-run is enough: a second trigger
	// during the same window just re-sets the same flag.
	let rerun = false;

	/**
	 * check — one pass of the publish decision (spec §5.2). Receives nothing
	 * (closes over the wiring above); returns a promise that always resolves.
	 * Never throws: it is called from a timer and from a socket callback, where
	 * a rejection has nobody to catch it.
	 */
	async function check() {
		if (running) { rerun = true; return; }               // one in flight at a time
		running = true;
		// Hoisted out of the try because the catch below needs the state that was
		// read on this pass to queue an orphaned key without clobbering the rest.
		let st = null;
		try {
			const history = await nina.history();
			const pick = selectLatestLight(history);
			st = state.load();
			if (!pick) { failures = 0; return; }
			if (pick.entry.Filename === st.lastFilename) { failures = 0; return; }

			const jpeg = await nina.imageByIndex(pick.index, cfg.imageScale, cfg.jpegQuality);
			const dims = jpegDimensions(jpeg) || { width: null, height: null };
			let next = null;
			// A camera that has gone offline between the save and this call must not
			// block the publish — the frame on disk is still the news. Only the
			// "next frame at" line is lost.
			try { next = nextFrameExpectedAt(await nina.cameraInfo(), Date.now()); }
			catch (err) { log.warn(`camera/info unavailable (${err.message}); publishing without nextFrameExpectedAt`); }
			const resolved = await resolver.resolve(pick.entry.TargetName);
			// The REAL public URL, computed before the upload rather than after. Both
			// halves are known here: publish() derives the object key from the status
			// timestamp via keyForFrame, and buildStatus derives that timestamp from
			// this same entry.Date — so keyForFrame(entry.Date) is the key publish()
			// will pick. Building it now is what lets the pre-publish gate below judge
			// the document that actually ships, URL included. A placeholder here would
			// hide a bad publicBaseUrl until after both PUTs had already happened.
			const frameUrl = `${publicBase}/${keyForFrame(pick.entry.Date)}`;
			const status = buildStatus({
				entry: pick.entry, subsTonight: countSubsTonight(history, pick.entry), nextFrameExpectedAt: next,
				resolved, frameUrl, width: dims.width, height: dims.height,
			});

			// Validate BEFORE the side effect (Power of Ten rule 5). Nothing is
			// substituted: this is the finished document, so every check — schemaVersion,
			// updatedAt, target.name, exposure, the https URL, and the privacy invariant
			// — is decided while a rejection still costs nothing.
			const pre = validateStatus(status);
			if (!pre.ok) throw new Error(`status rejected: ${pre.reason}`);

			const result = await publisher.publish({ jpegBuffer: jpeg, status, prevKey: st.lastKey, pendingDelete: st.pendingDelete });

			// Tripwire, not a gate — nothing reachable today fails either check.
			// The comparison is against `frameUrl`, the URL BUILT AND VALIDATED above,
			// deliberately not against status.frame.url: publish() re-assigns that field
			// from its own derivation, so comparing it would only ever compare publish()
			// with itself and pass no matter how far the two derivations had drifted.
			// A difference here means keyForFrame or the base-URL trimming changed on one
			// side only — a real bug, worth a loud line even though the document is
			// already public by the time it is found.
			const post = validateStatus(status);
			if (!post.ok) throw new Error(`status rejected after publish: ${post.reason}`);
			if (frameUrl !== result.url) {
				throw new Error(`published URL mismatch: validated ${frameUrl}, publish wrote ${result.url}`);
			}

			state.save({ lastFilename: pick.entry.Filename, lastKey: result.key, pendingDelete: result.pendingDelete });
			failures = 0;

			// A null designation means Simbad had no answer for this name — an outage,
			// or a target Simbad does not carry. Say so rather than printing "null":
			// the card is degraded (raw name, no catalog number) and the operator's
			// fix is an overrides.json entry.
			const label = resolved.designation
				? `"${resolved.name} / ${resolved.designation}"`
				: `"${resolved.name}" (unresolved)`;
			const pending = result.pendingDelete.length > 0 ? ` pendingDelete=${result.pendingDelete.length}` : '';
			log.info(`published ${result.key} target="${pick.entry.TargetName}" -> ${label} filter=${pick.entry.Filter} exp=${pick.entry.ExposureTime}s subsTonight=${status.frame.subsTonight} dims=${dims.width}x${dims.height} bytes=${jpeg.length}${pending}`);
			// Delete failures never abort a publish, so this is the only place they
			// are visible. One line for the whole batch, keys and reasons together.
			if (result.deleteErrors.length > 0) {
				log.warn(`delete failed for ${result.deleteErrors.map(e => `${e.key}: ${e.message}`).join('; ')}`);
			}
		} catch (err) {
			failures++;
			// Normalized once: a thrown null or undefined makes the property reads
			// below throw INSIDE the catch, where the rejection has nowhere to go,
			// and a thrown string has no .message and would log as "undefined".
			// One normalization plus the `err &&` guard below covers both.
			const message = err && err.message ? err.message : String(err);
			// publish() tags a status-PUT failure with the JPEG key it had already
			// uploaded. Nothing references that object now, so queue it for the next
			// publish's delete pass; lastFilename/lastKey stay as they were, because
			// the frame they name is still the one that is live.
			if (err && typeof err.orphanKey === 'string') {
				const prev = st || state.load();
				try {
					state.save({
						lastFilename: prev.lastFilename, lastKey: prev.lastKey,
						pendingDelete: [...prev.pendingDelete, err.orphanKey].slice(-MAX_PENDING_DELETE),
					});
					log.warn(`queued orphaned frame ${err.orphanKey} for deletion (status upload failed)`);
				} catch (saveErr) {
					// The object stays in R2 and nothing will ever delete it. That is a
					// leak worth an ERROR line rather than a silent pass.
					log.error(`could not queue orphaned frame ${err.orphanKey}: ${saveErr.message}`);
				}
			}
			log.warn(`check failed: ${message}`);
			if (failures >= REPEAT_WARN_AFTER) log.warn(`check failing repeatedly (n=${failures})`);
		} finally {
			running = false;
			// A trigger arrived mid-pass: serve it now rather than losing it. The flag
			// is cleared BEFORE the call so the new pass can set it again for a trigger
			// of its own. Not awaited (nothing awaits check() from a timer or a socket
			// callback either) and safe to ignore: check() always resolves.
			// Bounded, not unbounded recursion (Power of Ten rule 1): each re-entry
			// consumes the flag, so a further one requires ANOTHER external trigger
			// during the new pass. The depth is therefore set by how many IMAGE-SAVE
			// events NINA emits, not by this line, and in practice the new pass
			// suspends at its first await before the old one's frame is gone.
			if (rerun) { rerun = false; void check(); }
		}
	}

	if (once) { await check(); return { stop() {} }; }

	// --- socket with reconnect (intentionally infinite: this is a daemon) ---
	const trigger = createDebouncer(check, DEBOUNCE_MS);
	let socket = null;
	// The reconnect policy — when to retry and how long to wait — lives in
	// lib/backoff.js so it can be tested without a socket or a real clock
	// (tests/now-imaging/agent-socket.test.js). All that stays here is the wiring:
	// open a socket, hand its state changes to the policy. `reconnector` is read
	// inside the callback below, which only runs after the const is initialised.
	const reconnector = createReconnector({
		connect() { socket = nina.openSocket(trigger, (s) => reconnector.onState(s)); },
		log,
	});

	log.info(`agent started (nina=${cfg.ninaBaseUrl}, ${cfg.dryRunDir ? 'DRY-RUN ' + cfg.dryRunDir : 'bucket ' + cfg.r2Bucket})`);
	reconnector.start();
	// Heartbeat: the safety net for a dropped socket or an unexpected event shape.
	// Intentionally never cleared except by stop() — this interval IS the loop.
	const heartbeat = setInterval(check, cfg.heartbeatSeconds * 1000);
	await check();                                          // catch up after a restart mid-night

	return {
		stop() {
			// The reconnector first: closing the socket below fires its 'closed'
			// handler, and without the stop it would answer the shutdown by arming one
			// more reconnect. stop() also clears any reconnect already pending.
			reconnector.stop();
			clearInterval(heartbeat);
			// A debounce pending from a last-moment IMAGE-SAVE would otherwise run a
			// check after shutdown and hold the event loop open for its window.
			trigger.cancel();
			if (socket) socket.close();
		},
	};
}

/**
 * parseArgs — read the three supported flags off argv.
 * Receives the argument array (argv minus node and the script); returns
 * {configPath, dryRun, once}. Throws when --config is given without a value,
 * rather than letting `undefined` reach readFileSync and report a nonsense path.
 */
function parseArgs(args) {
	let configPath = path.join(__dirname, 'config.json');
	const i = args.indexOf('--config');
	if (i !== -1) {
		const value = args[i + 1];
		if (!value || value.startsWith('--')) throw new Error('--config needs a path');
		configPath = value;
	}
	return { configPath, dryRun: args.includes('--dry-run'), once: args.includes('--once') };
}

if (require.main === module) {
	const { configPath, dryRun, once } = parseArgs(process.argv.slice(2));
	const cfg = loadConfig(configPath, dryRun ? { dryRunDir: path.join(__dirname, 'dry-run') } : {});
	// The logger is built here, before the handler below, so an unhandled
	// rejection lands in the same file as everything else. runAgent is given the
	// same instance rather than making its own, so both write one stream.
	const log = createLogger(cfg.logPath);
	process.on('unhandledRejection', (err) => { log.error(`unhandled rejection: ${err && err.stack || err}`); });
	runAgent({ cfg, once, deps: { log } }).catch((err) => {
		log.error(`fatal: ${err && err.stack || err}`);
		process.exit(1);
	});
}

module.exports = { loadConfig, runAgent, parseArgs };
