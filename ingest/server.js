/**
 * server.js — Image ingestion pipeline server for dustin-space
 *
 * Accepts a JPG + TIF pair, runs a full pipeline:
 *   1. Read FITS/EXIF metadata from TIF (via exiftool, optional)
 *   2. Plate-solve the JPG with ASTAP
 *   3. Simbad cone-search for annotation points
 *   4. vips: create 2400px preview WebP + 600px thumbnail WebP
 *   5. vips: generate DZI tile tree from TIF
 *   6. @aws-sdk/client-s3: upload DZI tiles to Cloudflare R2 (bucket: dustinspace)
 *   7. Update src/_data/images.json with the new entry
 *   8. git add / commit / push to GitHub
 *
 * Progress is streamed to the browser via Server-Sent Events (SSE).
 * The client POSTs files + form data to /api/process, receives a jobId,
 * then connects to /api/progress/:jobId to receive the SSE stream.
 *
 * Run: node server.js
 * Open: http://localhost:3333
 */

'use strict';

const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const os         = require('os');
// execFileSync: synchronous binary execution used for startup checks only.
// Async execution (run/runOrThrow) is now in lib/exec.js.
// Neither invokes a shell — arguments go directly to the OS, no injection risk.
const { execFileSync } = require('child_process');

// ─── config ───────────────────────────────────────────────────────────────────
// Manages instance-specific settings (ASTAP paths, R2 credentials, port) in
// ingest/config.json (gitignored). See lib/config.js for full docs.
const { loadConfig, getConfig } = require('./lib/config');

// Load config once at startup. getConfig() returns the current in-memory copy;
// setConfig()/saveConfig() update it at runtime (e.g. via POST /api/settings).
loadConfig();

// ─── paths ────────────────────────────────────────────────────────────────────

// The dustin-space project root is one level up from this ingest/ directory.
const PROJECT_ROOT  = path.resolve(__dirname, '..');
// IMAGES_JSON is imported from lib/gallery.js — no need to define it here.
const GALLERY_DIR   = path.join(PROJECT_ROOT, 'src/assets/img/gallery');

// ─── express + multer setup ───────────────────────────────────────────────────

const app    = express();
// limits.fileSize caps individual uploads at 500 MB — large enough for TIF
// source files, small enough to prevent a runaway upload from filling the disk.
const upload = multer({
	dest: os.tmpdir() + '/ingest-uploads/',
	limits: { fileSize: 500 * 1024 * 1024 },
	// Only accept JPG and TIF files — reject anything else before it hits disk.
	// Prevents accidental uploads of wrong file types (e.g. dragging a PNG).
	fileFilter: (req, file, cb) => {
		const ext = path.extname(file.originalname).toLowerCase();
		if (['.jpg', '.jpeg', '.tif', '.tiff'].includes(ext)) {
			cb(null, true);
		} else {
			cb(new Error(`Unsupported file type: ${ext}. Only JPG and TIF files are accepted.`));
		}
	},
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── pipeline orchestrator ───────────────────────────────────────────────────
// The main ingest pipeline with targeting mode support. See lib/pipeline.js.
const { runPipeline } = require('./lib/pipeline');

// ─── R2 bucket name (used in startup log) ────────────────────────────────────
const { R2_BUCKET } = require('./lib/r2');

// ─── gallery data (IMAGES_JSON path used in startup log) ─────────────────────
const { IMAGES_JSON } = require('./lib/gallery');

// ─── CSRF protection ─────────────────────────────────────────────────────────
// Blocks cross-origin mutation requests (POST/PUT/DELETE) by checking the
// Origin header. See middleware/csrf.js for why this is needed.
const csrfCheck = require('./middleware/csrf');
app.use('/api', csrfCheck);

// ─── route mounting ──────────────────────────────────────────────────────────
// Each route group is an Express Router in routes/*.js.
// Factory routers receive dependencies (upload, runPipeline, paths) as arguments.
// All routes are mounted under /api/ so the Router paths are relative (e.g. /process).

const createProcessRouter  = require('./routes/process');
const createMetadataRouter = require('./routes/metadata');
const createMiscRouter     = require('./routes/misc');
const settingsRouter       = require('./routes/settings');
const galleryRouter        = require('./routes/gallery');

app.use('/api', createProcessRouter({ upload, runPipeline }));
app.use('/api', createMetadataRouter({ upload }));
app.use('/api', createMiscRouter());
app.use('/api', settingsRouter);
app.use('/api', galleryRouter);

// ─── startup checks ───────────────────────────────────────────────────────────
console.log('\n── dustin-space ingest server ──────────────────────────────');

// Check for required external tools and warn about optional ones.
// Each entry has bin (the executable) and args (argument array) — passed directly
// to execFileSync so no shell is involved, same as the rest of the codebase.
const checks = [
	{ bin: 'vips',     args: ['--version'],       name: 'vips',     required: true  },
	// Check that the configured ASTAP binary actually exists on disk.
	// getConfig().astap_bin is loaded from config.json by loadConfig() above.
	{ bin: 'ls',       args: [getConfig().astap_bin],  name: 'astap',    required: false },
	// wrangler no longer required for R2 uploads — SDK handles it directly.
	{ bin: 'wrangler', args: ['--version'],        name: 'wrangler', required: false },
	{ bin: 'git',      args: ['--version'],        name: 'git',      required: true  },
	{ bin: 'exiftool', args: ['-ver'],             name: 'exiftool', required: false },
];

// Track missing required tools so we can exit before listen() if any are absent.
const missingRequired = [];

for (const check of checks) {
	try {
		execFileSync(check.bin, check.args, { stdio: 'pipe', timeout: 5000 });
		console.log(`  ✓ ${check.name}`);
	} catch {
		const flag = check.required ? '✗ (REQUIRED)' : '○ (optional)';
		console.log(`  ${flag} ${check.name}`);
		if (check.required) missingRequired.push(check.name);
		if (check.name === 'exiftool') {
			console.log('    → Install: sudo dnf install perl-Image-ExifTool');
		}
	}
}

// Exit early if required tools are missing — the server would fail at runtime
// anyway, but a clear startup error is easier to diagnose than a mid-pipeline crash.
if (missingRequired.length > 0) {
	console.error(`\n  ✗ Missing required tools: ${missingRequired.join(', ')}. Cannot start.\n`);
	process.exit(1);
}

console.log(`\n  Project root : ${PROJECT_ROOT}`);
console.log(`  images.json  : ${IMAGES_JSON}`);
console.log(`  Gallery dir  : ${GALLERY_DIR}`);
console.log(`  R2 bucket    : ${R2_BUCKET}`);

// Warn if R2 credentials are still the placeholder strings from config.json.
// DZI tile uploads will fail at runtime until all three are replaced.
if (
	getConfig().r2_account_id.startsWith('FILL_IN') ||
	getConfig().r2_access_key_id.startsWith('FILL_IN') ||
	getConfig().r2_secret_access_key.startsWith('FILL_IN')
) {
	console.log('\n  ⚠  R2 credentials not set — DZI tile uploads will fail.');
	console.log('     Edit ingest/config.json and replace the three FILL_IN values.');
	console.log('     See the config comment in server.js for the click path.\n');
}

console.log('\n────────────────────────────────────────────────────────────\n');

// getConfig().port is loaded from config.json by loadConfig() above.
// Port changes written via POST /api/settings only take effect on the next restart.
// Bind to 127.0.0.1 (localhost only) instead of the default 0.0.0.0 (all interfaces).
// Without the explicit host, anyone on your LAN could reach the ingest UI.
app.listen(getConfig().port, '127.0.0.1', () => {
	console.log(`  Ready → http://localhost:${getConfig().port}\n`);
});
