// ── progress bar + elapsed timer state ────────────────────────────────────
// These variables track the current job's progress for the step bar and timer.
// They are reset at the start of each new job by resetProgress().

let progressTotal    = 0;   // total step count received in the 'init' event
let progressDone     = 0;   // number of 'step' events received so far
let elapsedInterval  = null; // setInterval handle for the timer
let elapsedStart     = 0;   // Date.now() at job start; used to compute elapsed seconds

// resetProgress — clears the bar and timer before a new job begins.
// Called from the submit handler just before the SSE connection opens.
function resetProgress() {
	progressTotal   = 0;
	progressDone    = 0;
	clearInterval(elapsedInterval);
	elapsedInterval = null;

	// Reset bar fill to 0 and show the bar container.
	document.getElementById('progress-bar-fill').style.width = '0%';
	document.getElementById('progress-steps').textContent    = '0 / 0 steps';
	document.getElementById('progress-elapsed').textContent  = 'Elapsed: 0:00';
	document.getElementById('progress-bar-wrap').classList.add('visible');

	// Expose the bar to assistive tech as a progressbar (0–100). The fill width
	// is a purely visual cue; aria-valuenow carries the same percentage for
	// screen readers and is kept in sync by updateProgressBar/finishProgressBar.
	// Issue #71 (WCAG 4.1.2 name/role/value).
	const track = document.getElementById('progress-bar-track');
	track.setAttribute('role', 'progressbar');
	track.setAttribute('aria-valuemin', '0');
	track.setAttribute('aria-valuemax', '100');
	track.setAttribute('aria-valuenow', '0');
}

// startElapsedTimer — starts a 1-second interval that updates the "Elapsed: X:XX"
// display while the job is running. Clears itself when stopElapsedTimer() is called.
function startElapsedTimer() {
	elapsedStart = Date.now();
	elapsedInterval = setInterval(() => {
		const totalSec = Math.floor((Date.now() - elapsedStart) / 1000);
		const m = Math.floor(totalSec / 60);
		const s = String(totalSec % 60).padStart(2, '0');
		document.getElementById('progress-elapsed').textContent = `Elapsed: ${m}:${s}`;
	}, 1000);
}

// stopElapsedTimer — clears the interval without resetting the display,
// so the final elapsed time is visible after the job finishes.
function stopElapsedTimer() {
	clearInterval(elapsedInterval);
	elapsedInterval = null;
}

// updateProgressBar — called on each 'step' event.
// Increments completedSteps, recalculates fill width, updates the "N / M steps" label.
// totalSteps — set by the 'init' event and stored in progressTotal.
function updateProgressBar() {
	progressDone++;
	if (progressTotal > 0) {
		const pct = Math.min(100, Math.round(progressDone / progressTotal * 100));
		document.getElementById('progress-bar-fill').style.width = pct + '%';
		// Keep the ARIA value in step with the visual fill. Issue #71.
		document.getElementById('progress-bar-track').setAttribute('aria-valuenow', String(pct));
	}
	document.getElementById('progress-steps').textContent =
		`${progressDone} / ${progressTotal || '?'} steps`;
}

// finishProgressBar — fills the bar to 100% on job completion (success or cancel).
function finishProgressBar() {
	document.getElementById('progress-bar-fill').style.width = '100%';
	// Bar is full — mirror that in the ARIA value. Issue #71.
	document.getElementById('progress-bar-track').setAttribute('aria-valuenow', '100');
	document.getElementById('progress-steps').textContent =
		`${progressDone} / ${progressTotal || progressDone} steps`;
}

// ── cancel support ─────────────────────────────────────────────────────────
// activeJobId holds the job ID while a run is in progress (set after POST /api/process).
// Cleared to null when the job ends so cancelJob() is a no-op after completion.
let activeJobId = null;

// cancelJob — sends DELETE /api/jobs/:jobId to signal cancellation.
// Called by the Cancel button (onclick="cancelJob()" in the HTML).
// The server sets job.cancelled = true; runPipeline checks isCancelled() between steps.
//
// Only hide the control after a CONFIRMED 200 from the server. Hiding it
// optimistically (the old behaviour) told the user "cancelling…" even when the
// DELETE never reached the server — leaving a job running with no way to stop it
// from the UI. On failure we keep the button and log a retryable error instead.
async function cancelJob() {
	if (!activeJobId) return;
	const btn = document.getElementById('btn-cancel');
	// Disable during the in-flight request so a double-click can't fire two DELETEs.
	btn.disabled = true;
	try {
		const resp = await fetch(`/api/jobs/${activeJobId}`, { method: 'DELETE' });
		if (!resp.ok) {
			// Server still holds the job but refused the cancel (e.g. 404 if it just
			// finished). Keep the control so the user can retry rather than assuming
			// it's cancelling.
			let data;
			try { data = await resp.json(); } catch { data = {}; }
			appendLog('error', 'Cancel failed: ' + (data.error || `server returned ${resp.status}`) + ' — try again.');
			btn.disabled = false;
			return;
		}
	} catch (err) {
		// Network failure — the DELETE didn't reach the server, so the job is still
		// running. Keep the button visible/enabled so the user can retry; do NOT
		// hide it (that would falsely imply the cancel succeeded).
		appendLog('error', 'Cancel request failed to reach the server: ' + err.message + ' — try again.');
		btn.disabled = false;
		return;
	}
	// Confirmed accepted (HTTP 200). Hide the control now; the SSE 'cancelled'
	// then 'done' events drive the rest of the UI teardown (via finishJob).
	btn.disabled = false;
	btn.classList.remove('visible');
}

// ── form submission ────────────────────────────────────────────────────────
// Handles the Publish button click end-to-end:
//   1. Validates required fields (title, slug, JPG).
//   2. Builds FormData from the form, then normalises two things the browser
//      doesn't handle automatically:
//      a. Toggle checkboxes: unchecked checkboxes are absent from FormData,
//         but the server expects "true" or "false". We delete then re-set each.
//      b. Tags: multiple checkboxes with the same name produce multiple entries;
//         we collapse them into a single comma-separated string.
//   3. POSTs to /api/process — receives { jobId } immediately.
//   4. Opens an EventSource (SSE) to /api/progress/:jobId.
//      SSE is a browser API that keeps a long-lived HTTP connection open and
//      fires onmessage each time the server sends a "data: ..." line.
//      Each message is a JSON-encoded pipeline event { type, message, slug }.
const form       = document.getElementById('ingest-form');
const btnPublish = document.getElementById('btn-publish');
const btnCancel  = document.getElementById('btn-cancel');
const statusEl   = document.getElementById('publish-status');
const logEl      = document.getElementById('progress-log');
const panel      = document.getElementById('progress-panel');

// ACTIVE_JOB_KEY — sessionStorage key holding the id of the job currently in
// flight. Set when a job starts, cleared on any terminal event. Its presence on
// page load means a job was still running when the page was reloaded/closed, so
// we can rejoin it (below) instead of orphaning the pipeline's live view.
const ACTIVE_JOB_KEY = 'ingest-active-job';

// connectToJob — open the SSE progress stream for `jobId` and wire every handler
// (progress rendering, terminal events, bounded auto-reconnect). Shared by the
// submit handler (a brand-new job) and the on-load rejoin path (a job that was
// still running when the page was last unloaded).
//
// rejoining — false for a fresh submit (the handler already reset the bar and
//   started the timer); true when reconnecting after a reload, where we rebuild
//   the UI from the server's replayed event buffer instead.
//
// Extracted from the submit handler so the reload-rejoin path reuses the exact
// same event wiring rather than duplicating ~70 lines that could drift apart.
function connectToJob(jobId, rejoining) {
	// Store the active job ID so cancelJob() can DELETE it and a reload can rejoin.
	activeJobId = jobId;
	try { sessionStorage.setItem(ACTIVE_JOB_KEY, jobId); } catch (err) {
		console.warn('[pipeline] sessionStorage unavailable:', err.message);
	}

	if (rejoining) {
		// Fresh page: the submit handler's UI setup never ran this session. Recreate
		// it so the replayed init/step events rebuild the progress bar correctly.
		// We deliberately do NOT startElapsedTimer() — the true start time was lost
		// with the previous page, so a timer from now would be misleading.
		btnPublish.disabled = true;
		btnCancel.disabled = false;
		btnCancel.classList.add('visible');
		panel.classList.add('visible');
		logEl.innerHTML = '';
		resetProgress();
		statusEl.textContent = 'Reconnecting to job in progress...';
	}

	// Connect to the SSE progress stream for this job.
	const es = new EventSource(`/api/progress/${jobId}`);

	// Bound the browser's automatic reconnect loop. EventSource retries forever on
	// a transient drop (readyState CONNECTING); if the server is truly unreachable
	// that spins indefinitely. Cap the attempts, then give up with a
	// verify-before-retry message. Power-of-Ten rule 2 (bound every loop).
	let sseReconnects = 0;
	const MAX_SSE_RECONNECTS = 5;

	// finishJob — teardown on any terminal event (done, expired) or a fatal
	// connection close: re-enable the form, hide cancel, stop the timer, clear the
	// active-job state including the sessionStorage marker (so a later reload won't
	// try to rejoin a job that already ended).
	function finishJob() {
		es.close();
		btnPublish.disabled = false;
		btnCancel.classList.remove('visible');
		stopElapsedTimer();
		finishProgressBar();
		activeJobId = null;
		try { sessionStorage.removeItem(ACTIVE_JOB_KEY); } catch (err) {
			console.warn('[pipeline] sessionStorage unavailable:', err.message);
		}
	}

	// A successful (re)connection resets the retry counter so a long job that
	// briefly drops and recovers isn't penalised for earlier blips.
	es.onopen = () => { sseReconnects = 0; };

	es.onmessage = e => {
		let event;
		try {
			event = JSON.parse(e.data);
		} catch (err) {
			console.warn('[pipeline] SSE JSON parse failed:', err.message, 'data:', e.data);
			return;
		}

		if (event.type === 'init') {
			// 'init' is sent at the very start of runPipeline with the total step count.
			// We use it to size the progress bar denominator.
			progressTotal = event.totalSteps || 0;
			document.getElementById('progress-steps').textContent =
				`0 / ${progressTotal} steps`;

		} else if (event.type === 'step') {
			// Each 'step' event = one pipeline step starting.
			// Increment the bar and log the message.
			updateProgressBar();
			appendLog('step', event.message);

		} else if (event.type === 'ok') {
			appendLog('ok', event.message);

		} else if (event.type === 'warn') {
			appendLog('warn', event.message);

		} else if (event.type === 'progress') {
			// 'progress' events are emitted during R2 upload batches.
			// Message format: "R2 upload: X/Y" — logged as-is.
			appendLog('progress', event.message);

		} else if (event.type === 'error') {
			// Non-terminal here: runPipeline always emits a 'done' immediately after
			// an 'error' (see fail() in lib/pipeline.js), and that 'done' is what
			// tears the job down. Just log the error line.
			appendLog('error', event.message);

		} else if (event.type === 'cancelled') {
			// Emitted by DELETE /api/jobs/:jobId — show as an info line. Not terminal:
			// the pipeline still emits an orphan-cleanup 'warn' (if R2 tiles were
			// uploaded) and a final 'done' before it actually stops, so finishing
			// here would drop that cleanup guidance.
			appendLog('cancelled', event.message);

		} else if (event.type === 'expired') {
			// Server tombstone for a job that was garbage-collected WITHOUT ever
			// emitting a terminal 'done' (it outlived the 30-min GC window while
			// still marked running). lib/jobs.js recordTombstone() synthesizes this
			// 'expired' line for exactly that no-terminal case — a real done/cancel/
			// error tombstone comes through the 'done' branch below instead. Terminal:
			// stop here rather than letting EventSource reconnect-loop against a 404,
			// and show "Job expired" instead of the misleading "Finished with errors".
			appendLog('error', event.message || 'This job is no longer available on the server.');
			statusEl.textContent = 'Job expired';
			finishJob();

		} else if (event.type === 'done') {
			if (event.slug) {
				// Save form state to localStorage on successful publish.
				// Uses the title as the key so the same setup can be restored next time.
				saveFormToLocalStorage(document.getElementById('f-title').value.trim());
				appendLog('done', `Done! Image "${event.title}" published as /${event.slug}/`);
				statusEl.textContent = '✓ Published';

				// Refresh the browse panel so the new entry appears immediately.
				// loadGallery() is defined in browse.js (loaded after this file).
				if (typeof loadGallery === 'function') loadGallery();
			} else if (event.cancelled) {
				appendLog('cancelled', 'Pipeline stopped.');
				statusEl.textContent = 'Cancelled';
			} else {
				statusEl.textContent = 'Finished with errors';
			}
			finishJob();
		}
	};

	es.onerror = () => {
		if (es.readyState === EventSource.CLOSED) {
			// Fatal: the server rejected or closed the stream (e.g. 404 for a job the
			// server no longer knows about). EventSource does NOT retry a CLOSED
			// stream, so end here with a verify-before-retry message.
			finishJob();
			statusEl.textContent = rejoining
				? 'The previous job is no longer available — reload the gallery to confirm whether it published.'
				: 'Connection lost. Reload the page to verify whether the job finished before retrying.';
		} else if (es.readyState === EventSource.CONNECTING) {
			// Transient drop; the browser is auto-reconnecting. Bound the attempts so
			// an unreachable server doesn't spin the reconnect loop forever.
			sseReconnects++;
			if (sseReconnects >= MAX_SSE_RECONNECTS) {
				es.close();
				finishJob();
				statusEl.textContent = `Lost connection to the pipeline after ${MAX_SSE_RECONNECTS} retries. Reload to verify the job status before retrying.`;
			}
		}
	};
}

form.addEventListener('submit', async e => {
	e.preventDefault();

	// Validate required fields based on current mode.
	const mode     = document.getElementById('f-mode').value;
	const title    = document.getElementById('f-title').value.trim();
	const slug     = document.getElementById('f-slug').value.trim();
	const jpgInput = document.querySelector('[name="jpg"]');

	if (mode === 'new-target') {
		if (!title) return alert('Please enter a title.');
		if (!slug)  return alert('Please enter a slug.');
	}
	if (!jpgInput.files.length) return alert('Please select a JPG file.');

	// --- encode toggles as string "true"/"false" (FormData booleans are tricky) ---
	// Checkboxes only appear in FormData when checked, but the server expects "true"/"false".
	const fd = new FormData(form);

	// Encode toggle fields explicitly so unchecked = "false".
	['platesolve','simbad','dzi','gitpush','featured'].forEach(name => {
		fd.delete(name);
		const el = document.querySelector(`[name="${name}"]`);
		fd.set(name, el && el.checked ? 'true' : 'false');
	});

	// Encode tags as a single comma-separated string.
	const tagValues = [...document.querySelectorAll('[name="tags"]:checked')].map(c => c.value);
	fd.delete('tags');
	fd.set('tags', tagValues.join(','));

	// Disable publish, show cancel, reset progress bar. Reset the cancel button's
	// disabled state too — a prior cancelled run may have left it disabled.
	btnPublish.disabled = true;
	btnCancel.disabled = false;
	btnCancel.classList.add('visible');
	statusEl.textContent = 'Uploading files...';
	panel.classList.add('visible');
	logEl.innerHTML = '';
	resetProgress();
	startElapsedTimer();

	// abortPublish — restore the pre-submit UI and surface a reason when the POST
	// fails before the job starts. Without this, a rejected upload left the publish
	// button disabled and the timer running forever. Mirrors the resp.ok precedent
	// in saveSettings() below.
	function abortPublish(message) {
		appendLog('error', message);
		statusEl.textContent = 'Publish failed';
		btnPublish.disabled = false;
		btnCancel.classList.remove('visible');
		stopElapsedTimer();
	}

	// POST the form data and get a job ID back.
	let jobId;
	try {
		const resp = await fetch('/api/process', { method: 'POST', body: fd });
		// The server can reject before the job starts (multer file-size limit,
		// malformed request) — the Express error middleware returns a JSON { error }
		// body with a non-2xx status. Parse defensively (a proxy could return
		// non-JSON), then let resp.ok separate success from failure.
		let data;
		try { data = await resp.json(); } catch { data = {}; }
		if (!resp.ok) {
			abortPublish('Upload rejected: ' + (data.error || `server returned ${resp.status}`));
			return;
		}
		jobId = data.jobId;
		if (!jobId) {
			// 200 but no jobId — the job never started. Don't open an EventSource
			// against an undefined id (which would just 404-loop).
			abortPublish('Server did not return a job ID — the job did not start.');
			return;
		}
	} catch (err) {
		abortPublish('Upload failed: ' + err.message);
		return;
	}

	statusEl.textContent = 'Processing...';

	// Hand off to the shared SSE connector: it records activeJobId, persists the id
	// for reload-rejoin, and wires all progress/terminal/reconnect handling.
	connectToJob(jobId, false);
});

// Warn before leaving while a job is still running. A reload or navigation-away
// tears down the live progress view (the server keeps processing regardless).
// sessionStorage lets a RELOAD rejoin the job (see the rejoin block at the end of
// this file), but leaving the site entirely still loses the view — so prompt.
window.addEventListener('beforeunload', e => {
	if (activeJobId) {
		e.preventDefault();
		// Legacy requirement: some browsers only show the prompt when returnValue
		// is set to a (non-empty) string. The custom text is ignored by modern
		// browsers, which show their own generic message.
		e.returnValue = '';
	}
});

// On page load, rejoin a job that was still running when the page was last
// unloaded (reload or crash). The jobId was stored in sessionStorage at job start
// and cleared on any terminal event; if it's still present, the job may still be
// live on the server, so reconnect and replay its buffered events. If the server
// no longer has it, the SSE 404s and connectToJob's onerror clears the marker.
(function rejoinActiveJob() {
	let saved;
	try { saved = sessionStorage.getItem(ACTIVE_JOB_KEY); } catch { saved = null; }
	if (saved) connectToJob(saved, true);
})();

// Appends one line to the pipeline progress log and scrolls to the bottom.
// type    — CSS class suffix: 'step' | 'ok' | 'warn' | 'progress' | 'error' | 'done'
//           | 'cancelled'
//           The CSS ::before rules add the icon prefix (▸, ✓, ⚠, ·, ✗, ★) automatically.
// message — the human-readable text to display.
//
// A monospace [tag] prefix is prepended to every message so that reading the
// raw log (e.g. when copied or printed) is still informative. Tags are padded
// to a consistent width so they visually column-align:
//   [info]  — step, progress, cancelled
//   [ok]    — ok, done
//   [warn]  — warn
//   [error] — error
// The font-mono class is applied only to the tag <span> so the message text
// stays in the UI font. Both sit side-by-side inside a flex container.
const LOG_TAGS = {
	step:      '[info] ',
	ok:        '[ok]   ',
	warn:      '[warn] ',
	progress:  '[info] ',
	error:     '[error]',
	cancelled: '[info] ',
	done:      '[ok]   ',
};

function appendLog(type, message) {
	const line = document.createElement('div');
	line.className = `log-${type}`;
	line.style.display = 'flex';
	line.style.gap = '0.5em';

	// Monospace tag prefix — padded so all tags occupy the same visual column width.
	const tag = document.createElement('span');
	tag.className = 'mono';
	tag.style.flexShrink = '0';
	tag.style.opacity    = '0.6';
	// LOG_TAGS is defined just above — maps event type → padded tag string.
	tag.textContent = LOG_TAGS[type] || '[info] ';

	// Message body — inherits the UI font from the parent div's .log-* class.
	const msg = document.createElement('span');
	msg.textContent = message;

	line.appendChild(tag);
	line.appendChild(msg);
	logEl.appendChild(line);
	logEl.scrollTop = logEl.scrollHeight;
}

// ── settings: load from server + save ─────────────────────────────────────
// On page load, GET /api/settings to populate the settings fields. Save is
// disabled until the load succeeds: saving from a form that never received the
// real values would POST blanks and could wipe the port/API key in config.json.
const saveSettingsBtn = document.getElementById('btn-save-settings');
if (saveSettingsBtn) saveSettingsBtn.disabled = true;

fetch('/api/settings')
	.then(r => {
		if (!r.ok) throw new Error(`server returned ${r.status}`);
		return r.json();
	})
	.then(cfg => {
		// cfg comes from config.json via the server — API key is masked, port is plain.
		document.getElementById('setting-astrometry-key').value = cfg.astrometry_api_key || '';
		document.getElementById('setting-port').value           = cfg.port               || '';
		// Values are in place — allow saving.
		if (saveSettingsBtn) saveSettingsBtn.disabled = false;
	})
	.catch(err => {
		// Persistent (non-auto-clearing) error, and Save stays disabled so a blank
		// form can't be written over the real config. The user must reload to retry.
		console.warn('[pipeline] Settings load failed:', err.message);
		const s = document.getElementById('settings-status');
		if (s) {
			s.style.color   = 'var(--red)';
			s.textContent   = `Could not load current settings (${err.message}). Reload the page before editing.`;
		}
	});

// saveSettings — reads the settings inputs and POSTs them to /api/settings.
// Shows a brief success or error message next to the button.
// Called by the "Save Settings" button (onclick="saveSettings()" in the HTML).
async function saveSettings() {
	const astrometry_api_key = document.getElementById('setting-astrometry-key').value.trim();
	const port               = parseInt(document.getElementById('setting-port').value, 10);
	const statusEl2          = document.getElementById('settings-status');

	// Basic client-side validation before sending.
	if (!port) {
		statusEl2.style.color = 'var(--red)';
		statusEl2.textContent = 'Port is required.';
		return;
	}

	try {
		const resp = await fetch('/api/settings', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ astrometry_api_key, port }),
		});
		const data = await resp.json();

		if (!resp.ok) {
			statusEl2.style.color = 'var(--red)';
			statusEl2.textContent = data.error || 'Save failed.';
			return;
		}

		statusEl2.style.color = 'var(--green)';
		statusEl2.textContent = data.restartRequired
			? '✓ Saved — restart required for port change.'
			: '✓ Saved.';

		// Clear the message after 4 seconds.
		setTimeout(() => { statusEl2.textContent = ''; }, 4000);

	} catch (err) {
		statusEl2.style.color = 'var(--red)';
		statusEl2.textContent = 'Network error: ' + err.message;
	}
}
