// sky.js — procedural "true sky" images to image through the array.
//
// Each preset returns an N×N Float64Array of brightness (≈0..1), object centered.
// These are the GROUND TRUTH the simulation knows but a real telescope never does —
// the whole point is to compare the reconstruction against this. Choices of target
// teach different things: a single point reveals the dirty beam directly; a close
// double tests resolution; a ring evokes the black-hole case and shows how sparse
// sampling fakes or destroys fine structure.

export const SKY_NAMES = ['point', 'double', 'disk', 'ring', 'galaxy'];

// addGaussian — accumulate a (optionally elongated, rotated) 2D Gaussian blob.
//   img : target Float64Array (n*n), modified in place.
//   cx,cy : centre in pixels. sx,sy : std-devs in pixels. amp : peak value.
//   theta : rotation of the major axis, radians.
// Loop is bounded by the image size (n*n); naturally bounded, no external input.
function addGaussian(img, n, cx, cy, sx, sy, amp, theta) {
	const cos = Math.cos(theta), sin = Math.sin(theta);
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const dx = x - cx, dy = y - cy;
			const rx = dx * cos + dy * sin;   // rotate into the blob's own axes
			const ry = -dx * sin + dy * cos;
			img[y * n + x] += amp * Math.exp(-(rx * rx / (2 * sx * sx) + ry * ry / (2 * sy * sy)));
		}
	}
}

// makeSky — build a named true-sky image at resolution n (power of two).
// Returns Float64Array(n*n). Throws on an unknown name (explicit failure, not a
// silent blank image, per the assert-your-assumptions rule).
export function makeSky(name, n) {
	// The whole pipeline (FFT, centering) assumes a power-of-two grid; fail loudly
	// rather than silently writing to a fractional centre index on an odd n.
	if (!Number.isInteger(n) || n <= 0 || (n & (n - 1)) !== 0) {
		throw new Error(`makeSky: n must be a positive power of two, got ${n}`);
	}
	const img = new Float64Array(n * n);
	const c = n / 2; // image centre in pixels

	switch (name) {
		case 'point': {
			// A true single-pixel delta. Its dirty image is EXACTLY the dirty beam,
			// which makes this the preset for seeing the array's PSF unmixed.
			img[c * n + c] = 1;
			break;
		}
		case 'double': {
			// Two unresolved points separated horizontally — the classic test of
			// whether the array can tell them apart (resolution = uv extent).
			const s = Math.round(n / 12);
			img[c * n + (c - s)] = 1;
			img[c * n + (c + s)] = 1;
			break;
		}
		case 'disk': {
			// A filled, uniform-brightness disk: a simple extended source.
			const r = n / 9;
			for (let y = 0; y < n; y++) {
				for (let x = 0; x < n; x++) {
					const dx = x - c, dy = y - c;
					if (dx * dx + dy * dy <= r * r) img[y * n + x] = 1;
				}
			}
			break;
		}
		case 'ring': {
			// A bright annulus — the black-hole-shadow morphology. Sharp edges carry
			// high spatial frequencies, so sparse arrays struggle to keep it round.
			const ro = n / 6, ri = n / 9;
			for (let y = 0; y < n; y++) {
				for (let x = 0; x < n; x++) {
					const dx = x - c, dy = y - c;
					const rr = Math.sqrt(dx * dx + dy * dy);
					if (rr <= ro && rr >= ri) img[y * n + x] = 1;
				}
			}
			break;
		}
		case 'galaxy': {
			// A compact bright core plus an extended, tilted elliptical halo — a
			// rough galaxy. Multi-scale structure shows how the reconstruction can
			// recover the big smooth shape but lose or smear the fine core.
			addGaussian(img, n, c, c, n / 8, n / 20, 0.7, Math.PI / 5); // tilted disk
			addGaussian(img, n, c, c, n / 40, n / 40, 1.0, 0);          // bright core
			break;
		}
		default:
			throw new Error(`makeSky: unknown sky preset '${name}'`);
	}
	return img;
}
