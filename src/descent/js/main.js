// PAGE BOOTSTRAP — load the corpus, compute the ladder in the browser, mount the
// descent, and render the licence attribution.
//
// Nothing on this page is a stored result. The reader's own browser runs the same
// tested analysis module the project runs offline, over the same CC-BY data, with a
// fixed seed. That is a deliberate cost: it means a reader who does not believe the
// numbers can open the source and check that no value was typed in by hand.

import { standardLadder, mulberry32 } from '../src/analysis/index.js';
import { loadCorpus } from './data.js';
import { mountDescent } from './descent.js';
// The run settings are imported, not declared: settings.js is the single home for
// SURROGATES and SEED, shared with the offline report and the verify tool, so this
// page can never quietly run different settings than the numbers it is checked
// against (QA 2026-09-01, CR-1/TA-2).
import { SURROGATES, SEED } from './settings.js';
// The listen strip lives in its own module so its wiring is node-testable;
// main.js's top-level bootstrap makes anything defined here untestable (QA TA-4).
import { renderListenStrip } from './listen.js';

// Labels for the attribution block. The block is rendered from the data file's own
// `attribution` object rather than written into the HTML, so the credit cannot drift
// away from the data it credits. Iterating the object's entries, rather than reading
// five known keys, means a field added to the data file appears on the page instead
// of being silently dropped: for a licence obligation, silently dropping is the one
// unacceptable failure.
const ATTRIBUTION_LABELS = {
	source: 'Paper',
	recordings: 'Recordings',
	license: 'Licence',
	repo: 'Data',
	note: 'This corpus',
};

/**
 * Render the CC-BY attribution block.
 * Receives: `dl` (a definition list element) and `attribution` (the object shipped
 *           inside data/codas.json).
 * Returns: nothing.
 */
function renderAttribution(dl, attribution) {
	dl.textContent = '';
	for (const [key, value] of Object.entries(attribution)) {
		const dt = document.createElement('dt');
		dt.textContent = ATTRIBUTION_LABELS[key] || key;
		const dd = document.createElement('dd');
		dd.textContent = String(value);
		dl.append(dt, dd);
	}
}

/**
 * Show a failure to the reader instead of an empty page.
 * Receives: `message` (what went wrong, in plain words).
 * Returns: nothing.
 *
 * Every failure path in the load and compute ends here. A page about honest
 * measurement that quietly renders nothing when its data is missing would be its own
 * counterexample, so the failure is stated, on screen, in the place the staircase
 * would have been.
 */
function showFailure(message) {
	const banner = document.getElementById('load-failure');
	const detail = document.getElementById('load-failure-detail');
	const loading = document.getElementById('loading');
	if (loading) {
		loading.hidden = true;
	}
	if (banner && detail) {
		detail.textContent = message;
		banner.hidden = false;
	}
	const stage = document.getElementById('stage');
	if (stage) {
		stage.hidden = true;
	}
}

/**
 * Gather every element the descent view writes to.
 * Receives: nothing.
 * Returns: an object of elements, keyed by the names descent.js expects.
 * Throws: an Error naming the first element that is missing from the document.
 *
 * WHY the ids are checked rather than assumed: a typo in either the HTML or this
 * list would otherwise surface as a thrown TypeError deep inside a render function,
 * pointing at the symptom rather than the cause. Checking here names the missing id.
 */
function collectElements() {
	const ids = {
		// `stage` and `attributionList` are here rather than fetched inline at their use
		// sites. Both used to bypass this check, which meant a typo in either id produced
		// a TypeError on null from somewhere deep in the render, the exact failure this
		// function's whole reason for existing is to convert into a named message.
		stage: 'stage', attributionList: 'attribution-list', surrogateCount: 'surrogate-count',
		svg: 'staircase', figureCaption: 'figure-caption',
		title: 'rung-title', removes: 'rung-removes', stepCount: 'rung-step-count',
		value: 'mi-value', receipt: 'rung-receipt',
		tension: 'rung-tension', failed: 'rung-failed-nulls',
		chips: 'controlled-chips', chipsEmpty: 'controlled-empty',
		preview: 'next-preview', previewText: 'next-preview-text',
		status: 'status', stepDown: 'step-down', stepBack: 'step-back', showAll: 'show-all',
		closing: 'closing', summaryHeadline: 'summary-headline',
		summaryBody: 'summary-body', summaryFailed: 'summary-failed-nulls',
		tableDetails: 'ladder-table-details', tableBody: 'ladder-table-body',
		ledeHeadline: 'lede-headline',
	};
	const els = {};
	for (const [name, id] of Object.entries(ids)) {
		const node = document.getElementById(id);
		if (!node) {
			throw new Error(`The page is missing the element with id "${id}".`);
		}
		els[name] = node;
	}
	return els;
}

/**
 * Wait for the browser to paint before running a blocking computation.
 * Receives: nothing.
 * Returns: a promise that resolves after the next two animation frames.
 *
 * The ladder takes roughly a fifth of a second of solid main-thread work. Without
 * this yield the "measuring" message would be written into the DOM and never
 * painted, so the reader would see a blank page for that time and then a finished
 * one. Two frames rather than one: the first schedules the paint, the second runs
 * after it has happened. A web worker was the alternative considered and rejected as
 * more machinery than a 200 millisecond task deserves, and it would have meant
 * shipping the analysis module down a second import path.
 */
function afterPaint() {
	return new Promise((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
	});
}

/**
 * Load, compute, and mount. The page's single entry point.
 * Receives: nothing.
 * Returns: a promise that resolves when the descent is on screen.
 */
async function start() {
	const loading = document.getElementById('loading');
	try {
		const els = collectElements();

		// Written from the constant the ladder is actually built with, so the method
		// section cannot describe a different analysis than the one that ran.
		els.surrogateCount.textContent = String(SURROGATES);

		const { attribution, codas, examples } = await loadCorpus();
		renderListenStrip(examples);

		// Written from the file that was actually fetched, for the same reason.
		if (loading) {
			loading.textContent = `Loading ${codas.length.toLocaleString('en-US')} codas `
				+ `and measuring the ladder in your browser.`;
		}
		renderAttribution(els.attributionList, attribution);

		await afterPaint();
		const ladder = standardLadder(codas, { surrogates: SURROGATES, rng: mulberry32(SEED) });
		if (!Array.isArray(ladder) || ladder.length < 2) {
			throw new Error('The analysis produced fewer than two steps, so there is no descent to show.');
		}

		// The reader's motion preference is read once, at mount. Changing the system
		// setting mid-visit is rare enough that live-updating it is not worth the
		// listener, and the page has no motion outside the number's fall.
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (loading) {
			loading.hidden = true;
		}
		els.stage.hidden = false;
		mountDescent({ ladder, els, reducedMotion, surrogates: SURROGATES });
	} catch (error) {
		showFailure(error && error.message ? error.message : String(error));
	}
}

/**
 * Route any failure that escapes start() to the same on-screen banner.
 * Receives: nothing.
 * Returns: nothing.
 *
 * WHY this exists as well as the try/catch inside start(). That block covers loading,
 * computing, and mounting, and then it is done. Everything the page does afterwards
 * runs from an event: the three button handlers and the one automatic step. A throw in
 * any of those escapes to the console, where a reader will never look, and leaves the
 * staircase frozen mid-descent with a stale number sitting under a heading that says it
 * is the result.
 *
 * On this page in particular that is the worst reachable failure. A number that has
 * quietly stopped being the answer to the question above it, presented exactly as
 * confidently as a correct one, is precisely the thing the whole piece is an argument
 * against. Saying "this broke" is always more honest than showing a stale figure, so
 * every uncaught path ends at the same banner rather than in silence.
 *
 * Both events are needed: `error` catches synchronous throws from handlers, and
 * `unhandledrejection` catches a rejected promise nobody awaited.
 *
 * The false-positive question was asked before reaching for something this broad, since
 * tearing down a working page over someone else's error would be its own bug. Two
 * things keep the surface narrow here: the page loads no third-party script at all, and
 * browser extensions run their content scripts in an isolated world whose errors do not
 * reach this listener. Failed resource loads do not bubble, so registering without
 * capture keeps those out too. What is left is essentially this project's own code.
 */
function installLastResortHandlers() {
	window.addEventListener('error', (event) => {
		showFailure(event.message || 'Something went wrong after the page had loaded.');
	});
	window.addEventListener('unhandledrejection', (event) => {
		const reason = event.reason;
		showFailure(
			(reason && reason.message) || String(reason || 'A background task failed after loading.')
		);
	});
}

// Registered BEFORE start() so a failure during loading is covered too, not only one
// after mount.
installLastResortHandlers();

// The promise is deliberately dropped: start() handles its own failures internally and
// the last-resort handlers above cover anything that escapes, so there is nothing left
// for a caller to await or catch. `void` marks that as a decision rather than an
// oversight (Power of Ten rule 7 on intentional ignores).
void start();
