// THE DESCENT — the staircase view and the stepping interaction.
//
// The reader starts holding an impressive number and walks down one step at a time.
// Each step removes one rival explanation for that number, and the number falls.
// This module owns the drawing and the state machine; all reader-facing prose comes
// from copy.js, and every number comes from the ladder the analysis core computed.
//
// The state is deliberately tiny: one integer, the index of the step currently being
// shown. Everything visible is a pure function of that index and the ladder array,
// so there is no way for the staircase, the readout, and the announcement to
// disagree about which step the reader is on.

import {
	RUNG_COPY, coverageTension, failedNullNote, descentSummary, formatBits, formatZ,
} from './copy.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Staircase geometry, in the SVG's own user units. The viewBox scales to whatever
// width the layout gives it, so these are proportions rather than pixels.
//
// WHY the box is this tall (520 rather than the 340 it started at): the SVG scales by
// WIDTH, so the only way to give the drawing more rendered height is to make it taller
// relative to its width. Height is the axis a descent is measured on, and at 340 the
// chart rendered about 270px tall beside a readout panel nearly three times that,
// which left the page's own hero instrument as the smaller half of the first screen.
// padLeft is 62 rather than 52 to leave a column for the rotated axis title.
const CHART = {
	width: 720,
	height: 520,
	padLeft: 62,
	padRight: 12,
	padTop: 26,
	padBottom: 62,
};

// How long the number takes to fall, in milliseconds. Long enough to read as a
// movement rather than a jump cut, short enough that stepping quickly does not feel
// like waiting. Skipped entirely when the reader has asked for reduced motion.
const FALL_MS = 650;

// The page auto-advances one step shortly after loading, so a reader who leaves
// after ten seconds has still seen the number fall at least once, which is the whole
// argument. It advances exactly once and never again: after that the descent belongs
// to the reader. Any interaction cancels the pending step, so the page never moves
// under someone's hand.
const AUTO_STEP_DELAY_MS = 2200;

/**
 * Create an SVG element with attributes.
 * Receives: `name` (SVG tag name) and `attrs` (plain object of attribute values).
 * Returns: the element, not yet attached to anything.
 *
 * SVG elements need createElementNS rather than createElement: an <rect> made in the
 * HTML namespace parses fine and renders nothing at all, which is a confusing bug to
 * chase. This helper exists so that mistake can only be made in one place.
 */
function svgEl(name, attrs = {}) {
	const node = document.createElementNS(SVG_NS, name);
	for (const [key, value] of Object.entries(attrs)) {
		node.setAttribute(key, String(value));
	}
	return node;
}

/**
 * Look up reader-facing copy for a rung.
 * Receives: a rung object from standardLadder().
 * Returns: a copy entry with `short`, `title`, `removes`, `chip`.
 *
 * Falls back to the analysis module's own `explains` string if a rung id appears
 * that copy.js does not know about, which would happen if someone adds a rung to the
 * ladder and forgets the prose. Showing the terse developer wording is worse than
 * the polished version and better than showing an empty panel.
 */
function copyFor(rung) {
	return RUNG_COPY[rung.id] || {
		short: rung.id,
		title: rung.label,
		removes: rung.explains,
		chip: rung.id,
	};
}

/**
 * Build the SVG path for the staircase's through-line.
 * Receives: `treads`, an array of { x0, x1, y } in user units, left to right, one per
 *           step currently on screen.
 * Returns: a path `d` string, or '' when there is nothing to draw.
 *
 * WHY tread-and-riser rather than joining the tops with a diagonal polyline: a
 * diagonal through six points is a trend line, and reads as one. It invites the eye to
 * interpolate between the steps and to extrapolate past the last one, neither of which
 * this measurement supports. A staircase silhouette is made of right angles: it says
 * six discrete states, each one a deliberate act by the reader, with nothing claimed
 * about the space in between.
 */
function stairPath(treads) {
	if (treads.length === 0) {
		return '';
	}
	const parts = [`M ${treads[0].x0} ${treads[0].y}`];
	treads.forEach((tread, index) => {
		if (index > 0) {
			// Carry the previous height across to this step's edge, then drop: the riser
			// sits exactly on the boundary between two treads.
			parts.push(`L ${tread.x0} ${treads[index - 1].y}`);
			parts.push(`L ${tread.x0} ${tread.y}`);
		}
		parts.push(`L ${tread.x1} ${tread.y}`);
	});
	return parts.join(' ');
}

/**
 * Draw the staircase.
 * Receives: `svg` (the <svg> element), `ladder` (all rungs), `revealed` (index of the
 *           step currently shown; every earlier step is also drawn), and `onStep`
 *           (called with a step index when the reader clicks or keys a column).
 * Returns: nothing; it replaces the SVG's contents.
 *
 * WHY each column is drawn in two parts rather than as a single bar of the reported
 * number: the honest picture is not "the measurement shrinks", it is "the null model
 * catches up with the measurement". Total column height is the raw measurement,
 * which barely moves for the first five steps. The dark mass is how much a matched
 * shuffle of the same data produces on its own. Only the bright band is evidence, and
 * watching the dark mass grow to swallow it is the argument this page is making, in
 * one picture. A plain bar chart of the corrected number would show the same six
 * values while hiding the mechanism that produces them.
 *
 * WHY THE BRIGHT BAND IS ON THE BOTTOM, against the usual convention that puts the
 * chance stratum at the base of a stacked bar. Please read this before "fixing" it
 * back, because the convention version was built, rendered, and rejected on evidence.
 *
 * A stacked bar gives exactly one stratum a baseline, and only that stratum can be
 * read against the axis. Every other band is a floating height, which is the hardest
 * quantity in all of charting to compare by eye. So the choice of what sits on the
 * baseline is the choice of what the chart is ABOUT.
 *
 * With the null on the bottom, the axis-readable quantity was the RAW measurement:
 * 1.684, 1.693, 1.717, 1.733, 1.757, 1.273. That rises across five of the six steps.
 * The page is called The Descent and its through-line climbed for most of the walk,
 * while the number the whole page tracks was left floating mid-air. In the side by
 * side renders (whale-song-artifacts/compare-A-null-bottom.png against
 * compare-B-signal-bottom.png) the giveaway is the labels: with the null at the
 * bottom, the "0.475" of step six sits at 1.27 on the axis. The label and the axis
 * disagreed about the same number.
 *
 * With the signal on the bottom, the tops read 1.604, 1.456, 1.145, 0.983, 0.967,
 * 0.475 straight off the axis, and every label sits at its own value. Nothing the old
 * arrangement said is lost: total height is still the raw measurement, the dark mass
 * still grows step by step, and by step six it is still visibly most of the column.
 *
 * The cost, stated plainly: a reader who expects chance at the bottom has to reparse
 * once. That is a real cost and it is paid once per reader. It buys the page's central
 * quantity being the one thing anybody can read off the axis, on every step, forever.
 */
function renderStaircase(svg, ladder, revealed, onStep) {
	const plotWidth = CHART.width - CHART.padLeft - CHART.padRight;
	const plotHeight = CHART.height - CHART.padTop - CHART.padBottom;
	const baseline = CHART.padTop + plotHeight;
	// A fixed axis for the whole descent: rescaling per step would let the bars stay
	// the same size while the numbers fell, which is the kind of chart this project
	// exists to complain about.
	//
	// Floored at half a bit because the ceiling is data-derived and divides every
	// coordinate below. A ladder whose measurements were all zero would make it zero,
	// every y() would return NaN, every coordinate would be written as the string
	// "NaN", and the browser would draw a blank chart without raising anything. A page
	// that silently renders nothing is worse than one that draws an empty axis, and
	// this way the axis is still there to show the reader that the values are flat.
	const maxBits = Math.max(0.5, Math.ceil(Math.max(...ladder.map((r) => r.mi)) / 0.5) * 0.5);
	const y = (bits) => baseline - (bits / maxBits) * plotHeight;
	const slot = plotWidth / ladder.length;
	// WHY the bars nearly fill their slots: at the old 0.56 the gaps were wider than the
	// bars, which is the signature of a bar chart comparing six unrelated categories.
	// This page is not comparing categories, it is walking down one staircase, and the
	// treads of a staircase touch. The remaining sliver of gap keeps the columns
	// countable and gives the through-line's risers somewhere to land.
	const barWidth = slot * 0.88;

	svg.textContent = '';
	// The viewBox is set from the same constant the drawing measures itself against.
	// It is also written in the HTML so the element has correct proportions before this
	// module runs, but the two drifted apart once already (the box stayed at its old
	// height and silently cropped the step labels off the bottom), so the drawing code
	// now has the last word.
	svg.setAttribute('viewBox', `0 0 ${CHART.width} ${CHART.height}`);

	// Axis: horizontal guides every half bit, labelled on the left.
	for (let bits = 0; bits <= maxBits + 1e-9; bits += 0.5) {
		svg.append(svgEl('line', {
			class: 'grid', x1: CHART.padLeft - 6, x2: CHART.padLeft + plotWidth,
			y1: y(bits), y2: y(bits),
		}));
		const label = svgEl('text', { class: 'axis-label', x: CHART.padLeft - 12, y: y(bits) + 4 });
		label.textContent = bits.toFixed(1);
		svg.append(label);
	}
	// The unit as a rotated axis title rather than a token parked above the top label,
	// where it read as a stray word belonging to nothing. rotate() takes the angle and
	// the point to turn about, so the text pivots on its own anchor rather than swinging
	// away from it.
	const midPlot = CHART.padTop + plotHeight / 2;
	const unit = svgEl('text', {
		class: 'axis-title', x: 16, y: midPlot,
		transform: `rotate(-90 16 ${midPlot})`,
	});
	unit.textContent = 'bits';
	svg.append(unit);

	// One { x0, x1, y } per step on screen, for the through-line. Treads span the full
	// slot rather than only the bar, so consecutive treads meet and the risers fall on
	// the boundaries between steps.
	const treads = [];
	const errorBars = [];
	ladder.forEach((rung, index) => {
		const centre = CHART.padLeft + slot * index + slot / 2;
		const left = centre - barWidth / 2;
		const shown = index <= revealed;
		// `is-flagged` carries the coverage warning into the chart, so a bar whose number
		// is caveated never renders in the same confident colour as one that is not.
		//
		// Each column is also a control: clicking it jumps the descent to that step
		// (artist review, ranked change 7 — six labelled slots that respond to nothing
		// is a missed affordance). Done as SVG groups with role="button" and tabindex
		// rather than HTML buttons positioned over the chart, so the hit target IS the
		// drawing and cannot drift out of alignment with it when the layout scales.
		// Keyboard activation handles Enter and Space itself, because role="button" is
		// a promise to assistive tech that the element behaves like a button, and an
		// SVG group gets none of that behaviour for free the way a real <button> would.
		const stepCopy = copyFor(rung);
		const group = svgEl('g', {
			class: `rung${shown ? ' is-shown' : ''}${index === revealed ? ' is-current' : ''}`
				+ `${rung.reliable ? '' : ' is-flagged'}`,
			role: 'button',
			tabindex: '0',
			'aria-label': `Go to step ${index + 1}: ${stepCopy.title}`,
			'data-step': index,
		});
		// The current step is announced as current, not just painted as current: the
		// is-current highlight is class-only, which a screen reader never hears, so
		// without this the six columns read as identical buttons (QA CR-5).
		if (index === revealed) {
			group.setAttribute('aria-current', 'step');
		}
		// An SVG group has no hit area of its own — only its painted children receive
		// clicks. For a not-yet-shown step the painted content is a 10-unit sliver plus
		// two small labels, which made the pending columns near-unclickable targets for
		// a control whose cursor invites clicking (QA CR-4). This rect makes the whole
		// slot the target. fill="transparent" rather than "none", deliberately: the
		// default pointer-events is visiblePainted, and a fill of none does not count
		// as painted, so a none-filled rect would receive nothing and this fix would
		// silently no-op.
		group.append(svgEl('rect', {
			class: 'rung-hit', x: centre - slot / 2, y: CHART.padTop,
			width: slot, height: baseline - CHART.padTop + CHART.padBottom,
			fill: 'transparent',
		}));
		group.addEventListener('click', () => onStep(index));
		group.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				// Space would otherwise scroll the page, which is the opposite of pressing
				// the button the reader is focused on.
				event.preventDefault();
				onStep(index);
			}
		});

		if (shown) {
			// Bright band, sitting ON the baseline: the reported number, so its top can be
			// read straight off the axis on the left. See the stack-order note above the
			// function for why this is the stratum that gets the baseline.
			group.append(svgEl('rect', {
				class: 'bar-signal', x: left, y: y(rung.corrected),
				width: barWidth, height: Math.max(1, baseline - y(rung.corrected)),
			}));
			// Dark mass, stacked on top: what the matched null model produces by itself.
			// The column's full height is still the raw measurement.
			group.append(svgEl('rect', {
				class: 'bar-null', x: left, y: y(rung.mi),
				width: barWidth, height: Math.max(0, y(rung.corrected) - y(rung.mi)),
			}));
			// Error bar: one standard deviation of the null across its surrogates, drawn
			// about the boundary between the two bands. That boundary is now the reported
			// number itself, and this spread is the null-side component of its uncertainty,
			// so the two belong together. It is NOT the whole uncertainty on the
			// measurement: nothing on this page estimates sampling error on the real MI,
			// which is why the legend and the receipt both say what this tick actually is.
			//
			// Collected rather than appended here so it can be drawn LAST, over the
			// through-line. On the early steps the spread is genuinely narrower than that
			// line is thick, and drawing it first buried it. It is not enlarged to
			// compensate: a spread that small is the finding, and a chart that fattens an
			// error bar to make it visible is the habit this page exists to argue against.
			errorBars.push(svgEl('line', {
				class: 'bar-error', x1: centre, x2: centre,
				y1: y(rung.corrected - rung.nullStd), y2: y(rung.corrected + rung.nullStd),
			}));
			const value = svgEl('text', { class: 'bar-value', x: centre, y: y(rung.corrected) - 13 });
			value.textContent = formatBits(rung.corrected);
			group.append(value);
			if (!rung.reliable) {
				const flag = svgEl('text', { class: 'bar-flag', x: centre, y: y(rung.corrected) - 30 });
				flag.textContent = 'thin data';
				group.append(flag);
			}
			treads.push({ x0: centre - slot / 2, x1: centre + slot / 2, y: y(rung.corrected) });
		} else {
			// Steps not yet taken: a tread outline only. The reader can see how far the
			// staircase goes without being handed the ending.
			group.append(svgEl('rect', {
				class: 'bar-pending', x: left, y: baseline - 10, width: barWidth, height: 10,
			}));
		}

		const name = svgEl('text', { class: 'bar-label', x: centre, y: baseline + 22 });
		name.textContent = stepCopy.short;
		group.append(name);
		const step = svgEl('text', { class: 'bar-step', x: centre, y: baseline + 38 });
		step.textContent = `step ${index + 1}`;
		group.append(step);
		svg.append(group);
	});

	// The stair line itself, drawn over the columns it traces, and the error bars over
	// that, for the reason given where they are built.
	if (treads.length > 1) {
		svg.append(svgEl('path', { class: 'stair-line', d: stairPath(treads) }));
	}
	for (const bar of errorBars) {
		svg.append(bar);
	}
}

/**
 * Build the list of facts shown under the number.
 * Receives: a rung object.
 * Returns: an array of { term, value, flag?, note? } rows for the readout's definition
 *          list. Only the coverage row carries `flag`; `note` is the small print
 *          rendered under a value, and rows without one omit it.
 *
 * The null mean and its spread ship with every rung without exception, because a
 * number of 0.475 bits means nothing until the reader knows the null was at 0.798
 * and wandered by 0.016.
 */
function receiptRows(rung) {
	return [
		{
			term: 'null model',
			value: `${rung.nullMean.toFixed(3)} ± ${rung.nullStd.toFixed(3)} bits`,
			note: 'mean and one standard deviation over the shuffled surrogates',
		},
		{
			term: 'distance above the null',
			// WHY this row is the one that most needed a note: it is the only place on the
			// page where a number in the hundreds appears, and a three digit figure in a
			// unit that looks like sigma reads as certainty to anyone who knows the
			// convention and as a very big number to anyone who does not. Both readings are
			// more confident than this page can support.
			//
			// Capping the displayed value (printing "more than 100 null widths") was
			// considered and rejected: five of the six steps are three digit, so a cap
			// would flatten 602.3, 326.5, 138.3, 137.1 and 121.6 into one string and hide
			// the fact that this quantity falls down the ladder too, which is part of the
			// argument. The table below would still print the real values, so the page
			// would also be contradicting itself. Say what the number is instead.
			value: `${formatZ(rung.zScore)} null widths`,
			note: 'the gap between the measurement and the average shuffle, counted in widths '
				+ 'of the spread of those shuffles. A large value means the shuffles never came '
				+ 'close. It is not a precision on the measurement, and nothing on this page '
				+ 'claims one.',
		},
		{
			term: 'measured on',
			// blockCount is 1 at the first step, which has no grouping at all, so the plural
			// cannot be unconditional. A page arguing for care with numbers cannot print
			// "1 blocks" and expect to be believed about anything else.
			value: `${rung.pairs.toLocaleString('en-US')} pairs, ${rung.alphabetSize} coda types, `
				+ `${rung.blockCount.toLocaleString('en-US')} block${rung.blockCount === 1 ? '' : 's'}`,
			note: '',
		},
		{
			term: 'coverage',
			value: rung.reliable ? 'adequate' : 'thin, flagged unreliable',
			flag: rung.reliable ? 'ok' : 'warn',
			note: '',
		},
	];
}

/**
 * Compose the single sentence a screen reader hears when the step changes.
 * Receives: `rung`, its `index`, and the `total` number of steps.
 * Returns: a string.
 *
 * WHY one composed sentence rather than putting aria-live on the number itself:
 * a live region wrapped around a counting animation announces a stream of digits,
 * and a bare "0.475" tells a listener nothing about what changed. This sentence
 * carries the same four things the visual readout carries, in the order the page
 * argues them: what was removed, then the number, then its error bar, then its flag.
 */
function composeAnnouncement(rung, index, total) {
	const text = copyFor(rung);
	const flag = rung.reliable
		? 'Coverage is adequate.'
		: 'Coverage is thin and this step is flagged unreliable.';
	return `Step ${index + 1} of ${total}, ${text.title}. Removed: ${text.removes} `
		+ `Result: ${formatBits(rung.corrected)} bits. `
		+ `Null model ${rung.nullMean.toFixed(3)} plus or minus ${rung.nullStd.toFixed(3)} bits, `
		+ `${formatZ(rung.zScore)} null widths above chance. ${flag}`;
}

// Which run of animateNumber is currently allowed to write to the readout. Every call
// takes the next number and stamps its own frames with it; a frame belonging to an
// older run finds the counter has moved on and retires instead of writing. Module
// scope because the identity has to outlive the call that created it, and the page has
// exactly one headline number, so one counter is the whole state needed.
let animationGeneration = 0;

/**
 * Animate the headline number from one value to another.
 * Receives: `el` (the element whose text is the number), `from` and `to` (bits),
 *           `reducedMotion` (boolean).
 * Returns: nothing.
 *
 * The loop is bounded by elapsed time, not by an iteration count, and it always
 * finishes by writing the exact target value so a dropped frame can never leave a
 * wrong number on screen. When the reader has asked for reduced motion the value is
 * simply set, because a falling number is decoration here: the argument is carried
 * by the text beside it.
 *
 * WHY the generation counter: stepping faster than the 650ms fall used to leave two or
 * more of these loops alive at once, all writing the same node on every frame. The
 * value they settle on is still correct, because each writes its own exact target
 * last, but on the way there the digits visibly fight. Cancelling by generation is
 * cheaper than holding a frame handle and cannot leak one.
 */
function animateNumber(el, from, to, reducedMotion) {
	animationGeneration += 1;
	const generation = animationGeneration;
	if (reducedMotion || !Number.isFinite(from)) {
		el.textContent = formatBits(to);
		return;
	}
	const started = performance.now();
	const tick = (now) => {
		// A newer fall has started; this one is stale and must not write.
		if (generation !== animationGeneration) {
			return;
		}
		const elapsed = now - started;
		if (elapsed >= FALL_MS) {
			el.textContent = formatBits(to);
			return;
		}
		// Ease out: fast at first, settling at the end, which reads as something falling
		// and coming to rest rather than a linear counter.
		//
		// The fraction is clamped into 0..1 before the easing curve is applied. The loop
		// otherwise trusts that performance.now() only ever moves forward, and a single
		// backwards step makes the cubic explode: a headless render of this page caught a
		// frame reading "8016.649 bits". On a page whose entire subject is not overstating
		// a measurement, a nonsense number on screen for even one frame is the worst
		// available failure, and one clamp removes the whole class.
		const fraction = Math.min(1, Math.max(0, elapsed / FALL_MS));
		const progress = 1 - Math.pow(1 - fraction, 3);
		el.textContent = formatBits(from + (to - from) * progress);
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}

/**
 * Fill the readout panel for one step.
 * Receives: `els` (the panel's elements), `ladder`, `index`, `previous` (the index
 *           shown before this change, or null on first render), `reducedMotion`, and
 *           `surrogates` (how many null models each rung was built from, needed by the
 *           failed-null disclosure so it can quote the real denominator).
 * Returns: nothing.
 *
 * DOM order matters here and is not accidental: the rung's name and the rival
 * explanation it removes are written before the number, so a reader always knows
 * what the number is being compared against before they see it.
 */
function renderPanel(els, ladder, index, previous, reducedMotion, surrogates) {
	const rung = ladder[index];
	const text = copyFor(rung);

	els.title.textContent = text.title;
	els.removes.textContent = text.removes;
	els.stepCount.textContent = `Step ${index + 1} of ${ladder.length}`;

	const from = previous === null ? NaN : ladder[previous].corrected;
	animateNumber(els.value, from, rung.corrected, reducedMotion);
	els.value.classList.toggle('is-flagged', !rung.reliable);

	els.receipt.textContent = '';
	for (const row of receiptRows(rung)) {
		const dt = document.createElement('dt');
		dt.textContent = row.term;
		const dd = document.createElement('dd');
		dd.textContent = row.value;
		if (row.flag) {
			dd.classList.add(`flag-${row.flag}`);
		}
		if (row.note) {
			const note = document.createElement('span');
			note.className = 'receipt-note';
			note.textContent = row.note;
			dd.append(note);
		}
		els.receipt.append(dt, dd);
	}

	// Caveats belong beside the number they qualify, not in a footnote further down
	// the page where a reader who stops here would never meet them.
	const tension = coverageTension(rung);
	els.tension.textContent = tension;
	els.tension.hidden = tension === '';
	const failed = failedNullNote(rung, surrogates);
	els.failed.textContent = failed;
	els.failed.hidden = failed === '';

	// The strip of what is being controlled for, accumulated down the staircase.
	els.chips.textContent = '';
	for (let i = 1; i <= index; i++) {
		const chip = document.createElement('li');
		chip.textContent = copyFor(ladder[i]).chip;
		els.chips.append(chip);
	}
	els.chipsEmpty.hidden = index > 0;

	// What the next press will take away, so the question "compared to what?" is
	// answerable before the reader commits to the step.
	const next = ladder[index + 1];
	els.preview.hidden = !next;
	if (next) {
		els.previewText.textContent = copyFor(next).removes;
	}

	els.status.textContent = composeAnnouncement(rung, index, ladder.length);
}

/**
 * Fill the full ladder table.
 * Receives: `tbody` element and the `ladder`.
 * Returns: nothing.
 *
 * The table is the same six rungs in one view, offered inside a collapsed disclosure
 * so it does not give away the descent, and available to anyone who would rather
 * read the numbers than step through them. It is built from the ladder rather than
 * written by hand so it cannot disagree with the staircase.
 */
function renderTable(tbody, ladder) {
	tbody.textContent = '';
	ladder.forEach((rung, index) => {
		const tr = document.createElement('tr');
		const cells = [
			`${index + 1}. ${copyFor(rung).short}`,
			formatBits(rung.corrected),
			`${rung.nullMean.toFixed(3)} ± ${rung.nullStd.toFixed(3)}`,
			formatZ(rung.zScore),
			rung.pairs.toLocaleString('en-US'),
			rung.reliable ? 'adequate' : 'thin',
		];
		const th = document.createElement('th');
		th.setAttribute('scope', 'row');
		th.textContent = cells[0];
		tr.append(th);
		for (const value of cells.slice(1)) {
			const td = document.createElement('td');
			td.textContent = value;
			tr.append(td);
		}
		if (!rung.reliable) {
			tr.classList.add('is-flagged');
		}
		tbody.append(tr);
	});
}

/**
 * Mount the descent: draw the first step, wire the controls, and hand back nothing.
 * Receives: an object with
 *   - `ladder`        the computed rungs, in order;
 *   - `els`           every element the view writes to, gathered by main.js;
 *   - `reducedMotion` true when the reader has asked for less animation;
 *   - `surrogates`    null models per rung, quoted by the failed-null disclosure.
 * Returns: nothing. The module owns its own state from here.
 *
 * Interaction rules: the buttons are ordinary buttons, so keyboard operation comes
 * for free; the disabled state at the ends of the staircase is set on the buttons
 * themselves rather than implied by nothing happening.
 */
export function mountDescent({ ladder, els, reducedMotion, surrogates }) {
	let index = 0;
	let autoStepTimer = null;

	const goTo = (next) => {
		const target = Math.max(0, Math.min(ladder.length - 1, next));
		if (target === index && els.value.textContent !== '') {
			return;
		}
		const previous = els.value.textContent === '' ? null : index;
		index = target;
		renderStaircase(els.svg, ladder, index, jumpToStep);
		renderPanel(els, ladder, index, previous, reducedMotion, surrogates);
		// aria-disabled rather than the disabled attribute (QA AA-2): a keyboard
		// user who walks the descent to either end does it ON these buttons, and
		// hard-disabling the focused element drops their focus to the document
		// body. aria-disabled announces the end-of-staircase state while keeping
		// focus where it is; actually pressing the button there is already a
		// no-op, because goTo clamps its target and returns early on no change.
		const setEndState = (button, atEnd) => {
			if (atEnd) {
				button.setAttribute('aria-disabled', 'true');
			} else {
				button.removeAttribute('aria-disabled');
			}
		};
		setEndState(els.stepDown, index === ladder.length - 1);
		setEndState(els.stepBack, index === 0);
		els.figureCaption.textContent = `Step ${index + 1} of ${ladder.length} shown.`;
		if (index === ladder.length - 1) {
			els.closing.hidden = false;
		}
	};

	/**
	 * Jump straight to a step because the reader activated its column in the chart.
	 * Receives: `step` (index to show).
	 * Returns: nothing.
	 *
	 * Re-rendering the staircase destroys the very node the reader just activated, so
	 * whether the SVG held focus is checked BEFORE goTo and, if it did, focus is moved
	 * onto the freshly drawn group for the same step. Without this, a keyboard reader
	 * pressing Enter on a column is silently dumped back to the top of the document.
	 * preventScroll because the chart is already on screen (the reader is interacting
	 * with it) and a focus scroll would nudge the sticky layout for no reason.
	 */
	const jumpToStep = (step) => {
		cancelAutoStep();
		const svgHadFocus = els.svg.contains(document.activeElement);
		goTo(step);
		if (svgHadFocus) {
			const node = els.svg.querySelector(`[data-step="${step}"]`);
			if (node) {
				node.focus({ preventScroll: true });
			}
		}
	};

	// Any deliberate action cancels the automatic first step. The page is allowed to
	// demonstrate the fall once; it is not allowed to move while someone is reading.
	const cancelAutoStep = () => {
		if (autoStepTimer !== null) {
			clearTimeout(autoStepTimer);
			autoStepTimer = null;
		}
	};

	els.stepDown.addEventListener('click', () => {
		cancelAutoStep();
		goTo(index + 1);
	});
	els.stepBack.addEventListener('click', () => {
		cancelAutoStep();
		goTo(index - 1);
	});
	els.showAll.addEventListener('click', () => {
		cancelAutoStep();
		goTo(ladder.length - 1);
		els.tableDetails.open = true;
	});

	// The comment above used to be a promise the code did not keep: cancellation was
	// wired to the three buttons only, so a reader who had tabbed into the stage, or
	// put a finger on it, or started reading with a pointer resting there, still had
	// the page move under them. These three cover arriving by keyboard, by touch or
	// mouse, and by focus, and they are passive listeners on the stage rather than the
	// document so that scrolling elsewhere on the page does not count as engagement
	// with the staircase. `once` because the only thing they do is retire a one-shot
	// timer; after it has been cancelled there is nothing left to cancel.
	for (const eventName of ['keydown', 'pointerdown', 'focusin']) {
		els.stage.addEventListener(eventName, cancelAutoStep, { once: true, passive: true });
	}

	const summary = descentSummary(ladder);
	els.summaryHeadline.textContent = summary.headline;
	els.summaryBody.textContent = summary.body;
	// Hidden when empty, the same way renderPanel treats its two caveats. Setting only
	// the text left an empty amber-bordered box painted on the page whenever no null
	// build gave up, which reads as a warning about nothing.
	const summaryFailed = failedNullNote(ladder[ladder.length - 1], surrogates);
	els.summaryFailed.textContent = summaryFailed;
	els.summaryFailed.hidden = summaryFailed === '';
	renderTable(els.tableBody, ladder);

	goTo(0);
	els.ledeHeadline.textContent = `${formatBits(ladder[0].corrected)} bits`;

	// The one automatic move. A reader who arrives, reads the first number, and leaves
	// has still watched it fall once, which is the claim this page is here to make.
	//
	// Skipped outright under prefers-reduced-motion. The setting was previously read
	// only by animateNumber, so a reader who had asked for less motion still got the
	// page changing its own content unprompted; the animation was suppressed and the
	// unrequested change was not, which is the wrong half to honour. WCAG 2.2.2 is
	// about moving and auto-updating content, and while a single non-looping step is
	// arguably outside it, the reader's stated preference settles the question without
	// needing to decide the standard. The staging and the 2.2 second delay are
	// deliberately untouched for everyone else.
	if (!reducedMotion) {
		autoStepTimer = window.setTimeout(() => {
			autoStepTimer = null;
			// Gated on the reader still being at the top of the staircase, not only on the
			// cancel above. If a click ever raced the clearTimeout, an ungated goTo(1) would
			// yank a reader who had walked to step 4 back to step 2, which is a far worse
			// failure than skipping the demonstration.
			if (index === 0) {
				goTo(1);
			}
		}, AUTO_STEP_DELAY_MS);
	}
}
