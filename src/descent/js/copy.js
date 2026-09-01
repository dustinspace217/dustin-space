// PAGE COPY — every sentence the reader sees that is not a number.
//
// WHY this lives in its own module, separate from the rendering code: the prose is
// the argument, and the argument is the point of this project. Keeping it in one
// file means the wording can be revised without touching mechanism, and a reviewer
// can read the whole editorial line in one sitting. The rendering module imports
// these and never invents copy of its own.
//
// House rule observed here: no em dashes in reader-facing text. Colons and commas
// carry the same pauses.
//
// The analysis module (src/analysis/ladder.js) ships its own short `explains`
// string per rung. We deliberately do NOT use it verbatim on the page: it is
// written for a developer reading a report table, it is terse, and it contains
// punctuation this page does not use. RUNG_COPY below is the reader-facing version,
// keyed by the module's rung `id` so the two cannot silently fall out of step: an
// unknown id falls back to the module's own text rather than rendering nothing.

/**
 * Format a corrected result in bits for display.
 * Receives: a number of bits.
 * Returns: a string with a fixed two decimal places.
 *
 * WHY two decimals and not the three this page used to print. The third decimal is not
 * resolvable. The last rung reports 0.475 against a null that wanders by 0.016 from
 * draw to draw, on 1,663 pairs, already flagged for thin coverage: the digit sits an
 * order of magnitude inside the noise of the thing it is being compared against.
 * Printing it is a confidence signal independent of anything the words alongside it
 * say, and on this page that is the one failure that matters.
 *
 * The digit count is FIXED rather than scaled per rung, because the headline number
 * counts down through these values and a changing digit count would make it jump width
 * mid-fall even with tabular figures. Fixed at the precision the WORST rung supports,
 * not the best, since the alternative is letting the strongest rung set the appearance
 * of the weakest.
 *
 * Deliberately NOT applied to the null mean and its spread, which keep three decimals:
 * there the third decimal is the entire quantity being reported. A spread of 0.003 bits
 * rounds to 0.00 at this precision, which would tell the reader the null does not
 * wander at all. Different quantities resolve differently, and each is printed at the
 * precision it actually supports.
 */
export function formatBits(bits) {
	return bits.toFixed(2);
}

/**
 * Format a z score (distance above the null, in null widths) for display.
 * Receives: a number, possibly NaN.
 * Returns: a string with one decimal place, or 'not defined' when the null did not
 *          wander at all.
 *
 * Two jobs. First, one decimal EVERYWHERE: the same z was printed as 28.8 in the
 * receipt and the table and as 29 in the caveat directly beneath them, which reads as
 * two different measurements of the same thing.
 *
 * Second, NaN safety. ladder.js sets zScore to NaN when nullStd is 0, which happens if
 * every surrogate returns an identical value. Unguarded, all five display sites would
 * print "NaN null widths above chance" to the reader. Saying the quantity is undefined
 * is honest and is what the offline report already does; printing NaN is a bug wearing
 * a number's clothes.
 */
export function formatZ(z) {
	return Number.isFinite(z) ? z.toFixed(1) : 'not defined';
}

/**
 * Reader-facing copy for each rung of the null ladder.
 * Keys are the `id` values produced by standardLadder() in src/analysis/ladder.js.
 * Each entry has:
 *   - `short`   the axis label under the staircase column (must fit ~100px)
 *   - `title`   the rung's name in the readout panel
 *   - `removes` the rival explanation this step removes, in plain words. This is
 *               the sentence that answers "compared to what?", and the page always
 *               shows it BEFORE the rung's number.
 *   - `chip`    the compact form listed in the "now controlling for" strip
 */
export const RUNG_COPY = {
	global: {
		short: 'no control',
		title: 'No control at all',
		removes: 'Nothing yet. Two codas count as neighbours simply because one row follows the other in the data file, even when they are years apart and come from different animals.',
		chip: 'nothing',
	},
	whale: {
		short: 'same whale',
		title: 'Same whale',
		removes: 'Different whales favour different codas. Once a pair has to come from one animal, some of the pattern turns out to be nothing more than hearing the same individual twice.',
		chip: 'whale identity',
	},
	day: {
		short: 'same day',
		title: 'Same recording day',
		removes: 'A day of recording has its own cast and its own context: which animals were present, what the group was doing, how the water sounded.',
		chip: 'recording day',
	},
	session: {
		short: 'whale + day',
		title: 'Same whale, same day',
		removes: 'Whale identity and recording day together. A pair is now two codas made by one animal inside one session.',
		chip: 'whale and day',
	},
	'session-clean': {
		short: '+ noise out',
		title: 'Annotation noise removed',
		removes: 'Some labels in this corpus mark artifacts of the annotation process rather than sounds a whale made. They are dropped, so they cannot manufacture pattern.',
		chip: 'annotation artifacts',
	},
	'session-clean-norepeat': {
		short: '+ repeats out',
		title: 'Repetition removed',
		removes: 'Whales say the same coda over and over. Saying a word twice is not grammar, so runs of one type collapse to a single occurrence. The null model is held to the same no repeats rule, otherwise the comparison would be rigged in favour of the whales.',
		chip: 'repetition',
	},
};

// The reliability rule mirrored for explanation only. src/analysis/ladder.js marks a
// rung reliable when it has at least 5 observed pairs for every cell of the
// alphabet-squared table of possible neighbour pairs. The FLAG the page displays is
// always the module's own `reliable` field, never recomputed here, so it cannot
// drift. This constant exists solely so the page can show the reader the arithmetic
// behind the flag. If the rule in ladder.js ever changes, this number must change
// with it, and the sentence below is the only place that would need editing.
const PAIRS_PER_CELL = 5;

/**
 * Build the sentence that explains a rung's coverage flag.
 * Receives: a rung object from standardLadder().
 * Returns: a plain-language string, or an empty string when the rung is reliable
 *          and therefore needs no caveat.
 *
 * All four numbers come from the rung itself, so this text cannot describe a
 * different measurement than the one on screen.
 */
export function coverageTension(rung) {
	if (rung.reliable) {
		return '';
	}
	const cells = rung.alphabetSize * rung.alphabetSize;
	const required = PAIRS_PER_CELL * cells;
	return `This step is flagged unreliable by this project's own rule, and it also sits `
		+ `${formatZ(rung.zScore)} null widths above chance. Both are true, and the page `
		+ `shows both. The rule is strict on purpose: it asks for at least ${PAIRS_PER_CELL} `
		+ `observed pairs for each of the ${cells.toLocaleString('en-US')} cells in the `
		+ `${rung.alphabetSize} by ${rung.alphabetSize} table of possible neighbour pairs, `
		+ `which is ${required.toLocaleString('en-US')} pairs, and this step has only `
		+ `${rung.pairs.toLocaleString('en-US')}. Thin coverage is a real reason for caution. `
		+ `At the same time, the matched null has already been subtracted, which removes most `
		+ `of the bias thin data creates, and the gap that remains is far outside the spread `
		+ `of that null. Read it as probably real, measured on less data than anyone would `
		+ `like. Showing the confident looking number and hiding the flag would be exactly `
		+ `the habit this page argues against.`;
}

/**
 * Build the disclosure sentence for no repeat shuffles the builder gave up on.
 * Receives: a rung object from standardLadder(), and `surrogates`, the number of null
 *           models built per rung (passed in from the page's own constant so this
 *           sentence cannot quote a count the page did not actually use).
 * Returns: a string, or empty when nothing was given up on.
 *
 * WHY this is never allowed to be silent: an attempt that gives up falls back to a
 * plain shuffle, which produces a slightly weaker null, which makes the whale result
 * look slightly stronger. Dropping the count would bias the headline upward in the
 * flattering direction.
 *
 * WHY THE WORDING IS THIS CAREFUL, since an earlier version of this sentence was
 * wrong in both halves and a future edit could reintroduce either:
 *
 * 1. The number is not a count of blocks. src/analysis/ladder.js accumulates it inside
 *    the surrogate loop, so it is a sum of give-ups across all the null models. On this
 *    corpus the seven land one apiece in seven of the twenty five draws, and repeated
 *    give-ups on the same stubborn block are counted separately. Saying "7 blocks"
 *    asserts something about the corpus that the number does not establish.
 *
 * 2. The cause is not impossibility. The earlier text said the blocks were so dominated
 *    by one coda type that no arrangement could avoid adjacency. That is measurably
 *    false: an arrangement exists whenever the commonest symbol fills at most half the
 *    slots rounded up, and zero of this step's 135 blocks breach that bound. What
 *    actually happens is that the builder searches at random under a deliberate retry
 *    cap and occasionally runs out of budget, on the few blocks where valid
 *    arrangements are rarest. Domination is why those blocks are hard, not why the
 *    attempt failed. Stating a search limit as a fact about whale behaviour is exactly
 *    the overclaim this page exists to argue against, which is why it is called out
 *    here rather than quietly corrected.
 */
export function failedNullNote(rung, surrogates) {
	if (!rung.failedNullBlocks) {
		return '';
	}
	const n = rung.failedNullBlocks;
	return `On ${n} occasion${n === 1 ? '' : 's'} out of the ${surrogates} null models built for `
		+ `this step, the no repeats shuffle gave up before it found a valid arrangement for one `
		+ `of the recording blocks. The builder searches at random and is capped on purpose so it `
		+ `can never spin, and the blocks it struggles with are the few where one coda type takes `
		+ `up close to half the block, which leaves very few valid arrangements to stumble on. `
		+ `Every block in this step can be arranged without repeats. The search simply ran out of `
		+ `tries. Those attempts fall back to a plain shuffle, which makes the null slightly `
		+ `easier to beat. The count is reported rather than dropped, because a hidden null `
		+ `failure biases the result upward.`;
}

/**
 * Build the closing summary of the whole descent.
 * Receives: the full ladder array from standardLadder().
 * Returns: { headline, body } strings, both computed from the ladder so they cannot
 *          contradict the staircase above them.
 */
export function descentSummary(ladder) {
	const first = ladder[0];
	const last = ladder[ladder.length - 1];
	const removedPct = Math.round(100 * (1 - last.corrected / first.corrected));
	return {
		headline: `${formatBits(first.corrected)} bits down to ${formatBits(last.corrected)} bits.`,
		body: `About ${removedPct} percent of the number this page opened with was rival `
			+ `explanations, not structure in what the whales said. That is the lesson, and it `
			+ `is the ordinary condition of a measurement before anyone controls anything. `
			+ `The ending is not that it was all nothing: ${formatBits(last.corrected)} bits `
			+ `survive every control this page applies, at ${formatZ(last.zScore)} null widths `
			+ `above chance. Something real is in there. It is roughly a third of what the `
			+ `opening number appeared to promise, and it comes with a coverage flag attached.`,
	};
}

// A METHOD_NOTE object used to sit here, holding a second copy of the method section's
// prose. Nothing ever imported it, while index.html carried its own near-identical
// wording, so the two were free to drift and the comment above them claimed a single
// source of truth that did not exist. Deleted rather than wired up: the method section
// is static prose with no numbers in it and belongs in the markup, and a file of copy
// that nothing reads is worse than no file at all. The rule this module still keeps is
// the one that matters, which is that every sentence built AROUND A NUMBER is composed
// here, from that number, and never typed twice.
