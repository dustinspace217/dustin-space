// THE LISTEN STRIP — DOM wiring for the hear-a-coda buttons.
//
// Extracted from main.js (QA 2026-09-01 TA-4): main.js top-level-executes its
// bootstrap, so nothing inside it can be imported under node, and everything in
// it is untestable by construction. This module has no top-level effects, so the
// wiring below — button creation, the disable window, and the press-time failure
// path — is pinned by tests/listen-wiring.test.js instead of being read-verified.
//
// The strip's failure contract, both halves: this is a nicety and the measurement
// above it must never depend on it. At RENDER time, missing prerequisites (no
// AudioContext, no eligible examples, missing markup) leave the strip hidden. At
// PRESS time, a throw from the player hides the strip and returns — without this,
// the page's last-resort handlers would route the error to the failure banner and
// a broken nicety would take down a working measurement (QA CR-6).

import { playCoda } from './sound.js';

/**
 * Fill and reveal the listen strip.
 * Receives: `examples` from loadCorpus() — [{ type, ici, count }].
 * Returns: nothing.
 *
 * Buttons are real <button> elements, so keyboard and screen-reader behaviour
 * come for free (unlike the chart's SVG controls, nothing here needs to sit on a
 * drawing). While a coda plays, ALL strip buttons are disabled for exactly the
 * train's duration — playCoda returns it — so neither the same rhythm nor a
 * DIFFERENT one can be layered over a train in flight; two overlapping rhythms
 * misrepresent both patterns to a first-time listener (QA CR-4; an earlier
 * version disabled only the pressed button).
 */
export function renderListenStrip(examples) {
	const strip = document.getElementById('listen-strip');
	const holder = document.getElementById('listen-buttons');
	if (!strip || !holder || !window.AudioContext || examples.length === 0) {
		return;
	}
	const buttons = [];
	// aria-disabled + a busy flag rather than the disabled attribute (QA AA-2):
	// disabling the button the keyboard user just pressed throws their focus to
	// <body>, and re-enabling does not bring it back. aria-disabled announces the
	// unavailable state to assistive tech while the element stays focusable; the
	// busy flag is what actually blocks re-entry, so a mid-train press is a no-op
	// instead of a second rhythm layered over the first (QA CR-4).
	let busy = false;
	for (const example of examples) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'listen-button';
		button.textContent = example.type;
		// The label carries what the visual strip carries: which rhythm, how common.
		button.setAttribute('aria-label',
			`Play the ${example.type} coda rhythm, the pattern of `
			+ `${example.count.toLocaleString('en-US')} codas in this corpus`);
		button.addEventListener('click', () => {
			if (busy) {
				return;
			}
			let seconds;
			try {
				seconds = playCoda(example.ici);
			} catch {
				// Press-time failure: vanish, never error. The catch is deliberately
				// broad — whatever the player threw, the page's job is to keep the
				// measurement standing, and a hidden strip is this feature's honest
				// broken state.
				strip.hidden = true;
				return;
			}
			busy = true;
			for (const b of buttons) {
				b.setAttribute('aria-disabled', 'true');
			}
			window.setTimeout(() => {
				busy = false;
				for (const b of buttons) {
					b.removeAttribute('aria-disabled');
				}
			}, seconds * 1000);
		});
		buttons.push(button);
		holder.append(button);
	}
	strip.hidden = false;
}
