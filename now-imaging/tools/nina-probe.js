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
	const idx = pick ? pick.index : h.length - 1;          // fall back to the newest ANY frame just to exercise decode
	const buf = await nina.imageByIndex(idx, 0.4, 80);
	console.log('image bytes:', buf.length, 'dims:', JSON.stringify(jpegDimensions(buf)));
})().catch(err => { console.error('probe failed:', err.message); process.exit(1); });
