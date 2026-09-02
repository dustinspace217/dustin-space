/**
 * now-imaging.js — DOM wiring for the homepage "Currently imaging" card.
 *
 * Fetches the status document the MeLe agent publishes, renders the card,
 * decides live vs idle, and schedules the next fetch from the agent's
 * nextFrameExpectedAt. This file fetches, checks the document's shape, and
 * paints; the liveness window, the fetch schedule and the caption text are all
 * decided by now-imaging-logic.js, which is where the unit tests reach them.
 * The section is never shown without a status; after a first success a later
 * failure leaves the last card in place.
 *
 * Spec: docs/superpowers/specs/2026-09-01-currently-imaging-design.md §6.2
 */
(function () {
	'use strict';

	var STATUS_URL = 'https://live.dustin.space/now/status.json';
	var FETCH_TIMEOUT_MS = 8000;
	// Refetch on tab return only if the last fetch is older than this.
	var STALE_ON_RETURN_MS = 60000;
	// Retry cadence after a failed fetch. Same 5 minutes the logic module uses
	// for its idle branch: a failure and an idle rig are the same situation
	// from here — nothing new to show, check back occasionally.
	var RETRY_ON_ERROR_MS = 5 * 60000;
	// Upper bound on any scheduled wait — see the note in schedule().
	var MAX_DELAY_MS = 3600000;

	var L = window.NowImagingLogic;
	var section = document.getElementById('now-imaging');
	if (!L || !section) return;                            // wrong page or logic file missing: do nothing

	var el = {
		label: document.getElementById('now-imaging-label'),
		frame: document.getElementById('now-frame'),
		img: document.getElementById('now-image'),
		tag: document.getElementById('now-frame-tag'),
		name: document.getElementById('now-name'),
		designation: document.getElementById('now-designation'),
		caption: document.getElementById('now-caption'),
		whats: document.getElementById('now-whats'),
		dialog: document.getElementById('now-dialog'),
		close: document.getElementById('now-dialog-close'),
	};
	var rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || 'en', { numeric: 'auto' });
	var timer = null;
	var lastFetchAt = 0;
	var lastUrl = null;

	/**
	 * render — paint one status document. Receives status and now (ms).
	 * Only swaps the image src when the frame URL changed, so the periodic
	 * refetch never re-downloads or flickers an unchanged frame.
	 */
	function render(status, nowMs) {
		var live = L.isLive(status, nowMs);
		section.classList.toggle('is-live', live);
		section.classList.toggle('is-idle', !live);
		// relativeAge returns '' for an updatedAt it cannot parse, and that is
		// the same input isLive() rejects — so the unparseable case always lands
		// on this idle branch. Concatenating it blind would print a dangling
		// "Last imaged · "; the label drops the separator with the age.
		var age = live ? '' : L.relativeAge(status.updatedAt, nowMs, rtf);
		el.label.textContent = live ? 'Currently imaging' : (age ? 'Last imaged · ' + age : 'Last imaged');

		var f = status.frame || {};
		if (f.width > 0 && f.height > 0) el.frame.style.aspectRatio = f.width + ' / ' + f.height;
		if (f.url && f.url !== lastUrl) {
			// alt is set here rather than unconditionally on purpose: with no
			// frame URL the <img> has no src, and a non-empty alt on a
			// src-less image renders as visible text in the card.
			el.img.alt = 'Latest single exposure of ' + status.target.name + ', unprocessed';
			el.img.src = f.url;
			lastUrl = f.url;
		}
		// The exposure is the only part of this tag that can be missing; the
		// "single, unprocessed" disclosure is the point of the tag and ships
		// either way. Number(null) is 0 and Number(undefined) is NaN, so an
		// isFinite check (not a truthiness check) is what keeps a literal
		// "NaN s" off the card.
		var exp = Number(f.exposureSeconds);
		var expText = isFinite(exp) && exp > 0 ? String(+exp.toFixed(2)) + ' s ' : '';
		el.tag.textContent = 'SINGLE ' + expText + 'EXPOSURE · UNPROCESSED';
		el.name.textContent = status.target.name;
		el.designation.textContent = status.target.designation || '';
		el.caption.textContent = L.caption(status);
		section.hidden = false;
	}

	/** schedule — one pending timer at a time; delay from the logic module. */
	function schedule(status, nowMs) {
		if (timer !== null) clearTimeout(timer);
		// The delay is derived from nextFrameExpectedAt, a field of a document
		// this page does not control, and nextFetchDelayMs floors it but does
		// not cap it. A delay above 2^31-1 ms is clamped into a 32-bit signed
		// int and fires at once rather than waiting (probed: Chromium 0 ms,
		// Node 1 ms, for 2147483648), so a bogus far-future timestamp would
		// become a fetch loop instead of a long sleep. An hour is the longest
		// wait worth having here anyway — past that, refetching costs one small
		// JSON request and re-syncs a card that may be hours stale.
		timer = setTimeout(refresh, Math.min(MAX_DELAY_MS, L.nextFetchDelayMs(status, nowMs)));
	}

	/**
	 * refresh — fetch + render + reschedule. Any failure leaves the current
	 * card as-is (or hidden if nothing has rendered yet) and retries on the
	 * idle cadence. `cache: 'no-store'` bypasses the browser cache; the edge
	 * doesn't cache JSON by default (spec §3).
	 */
	function refresh() {
		if (document.visibilityState !== 'visible') return;   // resume on visibilitychange
		// Cancel any pending timer before starting a request. Without this, the
		// visibilitychange path could start a fetch while a timer set before the
		// tab was hidden was still pending; that timer would then fire seconds
		// later and put a second fetch in flight. Spec §6.2 wants one at a time,
		// and every path that starts a fetch comes through here, so this one
		// line is the whole guarantee.
		if (timer !== null) clearTimeout(timer);
		timer = null;
		// Distinguishes a status that never arrived from a bug in our own paint.
		// Set just before render() runs, so the catch below can tell which side
		// of the boundary threw. Per-call, not closure state: two overlapping
		// refreshes would each need their own answer.
		var painting = false;
		var ctrl = new AbortController();
		var kill = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
		lastFetchAt = Date.now();
		fetch(STATUS_URL, { cache: 'no-store', signal: ctrl.signal })
			.then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
			.then(function (status) {
				// target.name is required by the schema and is read unguarded by
				// render (as the image alt and the card's heading), so a document
				// missing it is rejected here rather than rendered as the word
				// "undefined". frame.url is type-checked rather than merely
				// truth-checked because it is assigned straight to img.src: a
				// number or an object there would stringify into a bogus request.
				// A document with no usable frame URL has no frame to show, which
				// is the same nothing-to-paint case. Spec §6.2: a bad document
				// leaves the section hidden.
				if (!status || status.schemaVersion !== 1 || !status.target || !status.target.name ||
					!status.frame || typeof status.frame.url !== 'string') throw new Error('bad status shape');
				var now = Date.now();
				painting = true;
				render(status, now);
				schedule(status, now);
			})
			.catch(function (err) {
				// Quiet by design: a missing status is the normal state before the
				// first night. One console line for anyone debugging; no UI.
				// Two labels, because the two causes need different responses from
				// whoever is reading the console: everything the fetch path throws
				// (non-200, abort, network failure, unparseable JSON, failed shape
				// check) is "no status" and expected; anything thrown once painting
				// began is a bug in render() or schedule(). Both take the same
				// hidden-and-retry path — only the wording differs.
				if (window.console && console.info) {
					console.info(painting ? '[now-imaging] render failed:' : '[now-imaging] no status:', err.message);
				}
				if (timer !== null) clearTimeout(timer);
				timer = setTimeout(refresh, RETRY_ON_ERROR_MS);
			})
			.finally(function () { clearTimeout(kill); });
	}

	// Pause while hidden, refresh promptly on return if stale. Two things keep
	// this to one request at a time: lastFetchAt is stamped when a request
	// STARTS and the 8 s timeout is far shorter than the 60 s staleness
	// threshold, so an in-flight request still reads as fresh here; and
	// refresh() clears any pending timer before it fetches, so a timer set
	// before the tab was hidden cannot fire into a request this path started.
	//
	// A timer that fires while the tab is hidden returns early and is dropped —
	// recovery is this staleness check. That holds only while
	// nextFetchDelayMs's minMs floor (60 s) is ≥ STALE_ON_RETURN_MS: if the
	// floor ever drops below it, track a fired-while-hidden flag instead.
	document.addEventListener('visibilitychange', function () {
		if (document.visibilityState === 'visible' && Date.now() - lastFetchAt > STALE_ON_RETURN_MS) refresh();
	});

	// Dialog wiring. showModal() traps focus and handles Escape; backdrop click
	// closes because the dialog element itself receives the click while its
	// inner .now-dialog-body does not.
	// Nothing calls focus() after showModal() on purpose: the body carries
	// `tabindex="-1" autofocus` so showModal()'s focusing steps land on the
	// scroll container, which is what lets the arrow and Page keys read the
	// essay. Focusing anything else here would silently undo that.
	el.whats.addEventListener('click', function () { el.dialog.showModal(); });
	el.close.addEventListener('click', function () { el.dialog.close(); });
	el.dialog.addEventListener('click', function (ev) { if (ev.target === el.dialog) el.dialog.close(); });
	el.dialog.addEventListener('close', function () { el.whats.focus(); });

	refresh();
})();
