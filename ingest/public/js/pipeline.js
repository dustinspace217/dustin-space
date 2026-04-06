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
	}
	document.getElementById('progress-steps').textContent =
		`${progressDone} / ${progressTotal || '?'} steps`;
}

// finishProgressBar — fills the bar to 100% on job completion (success or cancel).
function finishProgressBar() {
	document.getElementById('progress-bar-fill').style.width = '100%';
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
async function cancelJob() {
	if (!activeJobId) return;
	try {
		await fetch(`/api/jobs/${activeJobId}`, { method: 'DELETE' });
	} catch {
		// Network failure — the server may still honour the cancel when it next checks.
	}
	// Hide the cancel button immediately — user feedback happens via the SSE 'cancelled' event.
	document.getElementById('btn-cancel').classList.remove('visible');
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

form.addEventListener('submit', async e => {
	e.preventDefault();

	// Validate required fields.
	const title = document.getElementById('f-title').value.trim();
	const slug  = document.getElementById('f-slug').value.trim();
	const jpgInput = document.querySelector('[name="jpg"]');

	if (!title) return alert('Please enter a title.');
	if (!slug)  return alert('Please enter a slug.');
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

	// Disable publish, show cancel, reset progress bar.
	btnPublish.disabled = true;
	btnCancel.classList.add('visible');
	statusEl.textContent = 'Uploading files...';
	panel.classList.add('visible');
	logEl.innerHTML = '';
	resetProgress();
	startElapsedTimer();

	// POST the form data and get a job ID back.
	let jobId;
	try {
		const resp = await fetch('/api/process', { method: 'POST', body: fd });
		const data = await resp.json();
		jobId = data.jobId;
	} catch (err) {
		appendLog('error', 'Upload failed: ' + err.message);
		btnPublish.disabled = false;
		btnCancel.classList.remove('visible');
		stopElapsedTimer();
		return;
	}

	// Store the active job ID so cancelJob() can send DELETE /api/jobs/:jobId.
	activeJobId = jobId;

	statusEl.textContent = 'Processing...';

	// Connect to the SSE progress stream for this job.
	const es = new EventSource(`/api/progress/${jobId}`);

	// Helper to clean up the job state on any terminal event (done, error, cancel).
	// re-enables the form, hides cancel, stops timer, clears activeJobId.
	function finishJob() {
		es.close();
		btnPublish.disabled = false;
		btnCancel.classList.remove('visible');
		stopElapsedTimer();
		finishProgressBar();
		activeJobId = null;
	}

	es.onmessage = e => {
		let event;
		try { event = JSON.parse(e.data); } catch { return; }

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
			appendLog('error', event.message);

		} else if (event.type === 'cancelled') {
			// Emitted by DELETE /api/jobs/:jobId — show as an info line.
			appendLog('cancelled', event.message);

		} else if (event.type === 'done') {
			if (event.slug) {
				// Save form state to localStorage on successful publish.
				// Uses the title as the key so the same setup can be restored next time.
				saveFormToLocalStorage(document.getElementById('f-title').value.trim());
				appendLog('done', `Done! Image "${event.title}" published as /${event.slug}/`);
				statusEl.textContent = '✓ Published';
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
		finishJob();
		statusEl.textContent = 'Connection lost';
	};
});

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
// On page load, GET /api/settings to populate the three settings fields.
// If the request fails we simply leave the placeholders in place.
fetch('/api/settings')
	.then(r => r.json())
	.then(cfg => {
		// cfg comes from config.json via the server — all three keys are guaranteed.
		document.getElementById('setting-astap-bin').value = cfg.astap_bin    || '';
		document.getElementById('setting-astap-db').value  = cfg.astap_db_dir || '';
		document.getElementById('setting-port').value      = cfg.port         || '';
	})
	.catch(() => { /* non-fatal — placeholders remain */ });

// saveSettings — reads the three settings inputs and POSTs them to /api/settings.
// Shows a brief success or error message next to the button.
// Called by the "Save Settings" button (onclick="saveSettings()" in the HTML).
async function saveSettings() {
	const astap_bin    = document.getElementById('setting-astap-bin').value.trim();
	const astap_db_dir = document.getElementById('setting-astap-db').value.trim();
	const port         = parseInt(document.getElementById('setting-port').value, 10);
	const statusEl2    = document.getElementById('settings-status');

	// Basic client-side validation before sending.
	if (!astap_bin || !astap_db_dir || !port) {
		statusEl2.style.color = 'var(--red)';
		statusEl2.textContent = 'All three fields are required.';
		return;
	}

	try {
		const resp = await fetch('/api/settings', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ astap_bin, astap_db_dir, port }),
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
