import { standardLadder, mulberry32 } from '../src/analysis/index.js';

/** Measure the one requested ladder and send either its result or a visible error.
 * Receives records and the shared run settings from computeLadder. The parent
 * terminates this worker afterward, releasing every cached completion count. */
self.onmessage = (event) => {
	try {
		const { codas, surrogates, seed } = event.data;
		const ladder = standardLadder(codas, { surrogates, rng: mulberry32(seed) });
		self.postMessage({ ladder });
	} catch (error) {
		self.postMessage({ error: error.message || String(error) });
	}
};
