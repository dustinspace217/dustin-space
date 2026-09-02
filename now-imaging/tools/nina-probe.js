// Usage: node tools/nina-probe.js http://100.106.198.18:1888 — prints history count, newest LIGHT, camera state.
'use strict';
const { createNina, jpegDimensions } = require('../lib/nina');
const { selectLatestLight } = require('../lib/select');
(async () => {
	const nina = createNina({ baseUrl: process.argv[2] || 'http://localhost:1888' });
	const h = await nina.history();
	const pick = selectLatestLight(h);
	console.log('history entries:', h.length, 'newest LIGHT:', pick ? pick.entry.Filename : 'none');
	const cam = await nina.cameraInfo();
	console.log('camera: exposing =', cam.IsExposing, 'end =', cam.ExposureEndTime);
	// With no LIGHT frame, fall back to the newest ANY frame just to exercise the
	// decode path. An EMPTY history has no newest frame at all: h.length - 1 would
	// be -1, and requesting /image/-1 asks NINA a question about a frame that does
	// not exist. Report and stop cleanly instead — an empty history is a normal
	// state (NINA just restarted), not a probe failure, so exit 0.
	if (h.length === 0) {
		console.log('history empty — nothing to decode');
		return;
	}
	const idx = pick ? pick.index : h.length - 1;
	const buf = await nina.imageByIndex(idx, 0.4, 80);
	console.log('image bytes:', buf.length, 'dims:', JSON.stringify(jpegDimensions(buf)));
})().catch(err => { console.error('probe failed:', err.message); process.exit(1); });
