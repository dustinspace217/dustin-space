// config.js — shared simulation constants, in one place so they can be tuned
// without hunting through modules.
//
// WHY a single shared scale (LAMBDA + UV_MAX) across all array presets: it makes
// the cross-array comparison honest. Because every preset is drawn on the SAME
// spatial-frequency scale, a physically larger/denser array genuinely reaches
// farther out in the uv-plane and produces a visibly sharper image — the core
// lesson. Auto-scaling per array would frame each one nicely but erase that.

export const N = 128;          // image grid side, power of two (radix-2 FFT)
export const LAMBDA = 1.0;     // observing wavelength, metres (sets the uv scale)
export const UV_MAX = 1500;    // spatial frequency (wavelengths) mapped to the grid edge
export const MAP_EXTENT_M = 1000; // half-width of the ground map window, metres (drag stays framed)

// Default observation/scene state the UI starts from. Phase 1 is a single-hour-angle
// "snapshot" (haSteps=1); Phase 2 widens the hour-angle span to fill uv-coverage via
// Earth rotation.
export const DEFAULTS = {
	sky: 'ring',
	array: 'spiral',
	decDeg: 45,        // source declination (degrees)
	// Default to a modest Earth-rotation track (±30° ≈ 4 hours): enough to fill the
	// uv-plane and drop sidelobes ~59%→14%, so the first view is a clean image. The
	// rotation slider scrubs this from 0 (snapshot) to ±90° (a full 12-hour track).
	haStartDeg: -30,   // hour-angle span start (degrees; 15°/hour)
	haEndDeg: 30,      // hour-angle span end
	haSteps: 15,       // number of time samples across the span
	noiseLevel: 0,     // thermal noise as a fraction of signal (0 = ideal/noiseless)
};
