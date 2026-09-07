import { SURROGATES, SEED } from './settings.js';

/** Compute the ladder without blocking the page; receives the parsed codas and
 * returns a promise of the ladder. One worker handles one run and is terminated
 * on success, error, or timeout, releasing its DP cache in every case.
 * The corrected sampler measured seconds of CPU work instead of the old ~200 ms;
 * moving just this computation preserves the page's controls and loading state. */
export function computeLadder(codas) {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
		const timer = setTimeout(() => finish(new Error('The measurement exceeded its one-minute time limit.')), 60_000);

		/** Settle this single job and release its worker, listeners, and deadline. */
		function finish(error, ladder) {
			clearTimeout(timer);
			worker.onmessage = null;
			worker.onerror = null;
			worker.onmessageerror = null;
			worker.terminate();
			if (error) reject(error);
			else resolve(ladder);
		}

		worker.onmessage = (event) => {
			if (event.data?.error) finish(new Error(event.data.error));
			else if (Array.isArray(event.data?.ladder)) finish(null, event.data.ladder);
			else finish(new Error('The measurement worker returned an invalid result.'));
		};
		worker.onerror = (event) => {
			event.preventDefault();
			finish(new Error(event.message || 'The measurement worker could not run.'));
		};
		worker.onmessageerror = () => finish(new Error('The measurement result could not be read.'));
		try {
			worker.postMessage({ codas, surrogates: SURROGATES, seed: SEED });
		} catch (error) {
			finish(error);
		}
	});
}
