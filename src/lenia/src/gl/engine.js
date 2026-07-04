// WebGL2 Lenia engine — the browser's real-time counterpart to src/core/sim.js.
//
// Same update rule as the CPU engine (PLAN.md "Verified ground truth"); the
// QA parity probe checks the two agree on identical inputs. The division of
// labor: GPU does direct convolution (729 taps/texel is nothing to a GPU and
// the code stays readable); CPU does FFT convolution (where direct would be
// too slow for the discovery search).
//
// Architecture: two single-channel float textures ping-pong as state. Each
// step renders source -> destination through the "step" shader (convolution
// + growth + clip). A "splat" shader handles brush strokes, and a "display"
// shader maps state -> color through a palette for the visible canvas.
//
// Why float textures: Lenia state is continuous in [0,1] and increments per
// step are ~dt*G = 0.1 or less; 8-bit storage (1/255 quanta) visibly
// quantizes slow dynamics. R32F is used when the driver can render to it
// (EXT_color_buffer_float — effectively universal on desktop), else R16F
// (EXT_color_buffer_half_float — covers older mobile). No 8-bit fallback:
// it would LOOK like Lenia but compute something subtly different, and this
// page's contract is honest machinery. We show a clear message instead.

import { buildKernel } from '../core/kernel.js';

const VERT = `#version 300 es
// Fullscreen triangle — covers the viewport with 3 vertices, no buffers
// needed (gl_VertexID trick). vUV ends up spanning [0,1]^2 across the screen.
out vec2 vUV;
void main() {
	vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
	vUV = p;
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const STEP_FRAG = `#version 300 es
precision highp float;
// One Lenia step for one texel:
//   u  = sum over kernel offsets of K(offset) * state(here + offset)
//   A' = clamp(A + dt * (2 exp(-((u-mu)/sigma)^2 / 2) - 1), 0, 1)
uniform sampler2D uState;    // current world, R channel, REPEAT wrap = torus
uniform sampler2D uKernel;   // (2R+1)^2 normalized weights (texelFetch'd)
uniform float uN;            // world size in cells
uniform int uR;              // kernel radius in cells
uniform float uDt;           // 1/T
uniform float uMu, uSigma;   // growth center / width
in vec2 vUV;
out vec4 outColor;
void main() {
	float u = 0.0;
	// Dynamic loop bounds are legal in GLSL ES 3.00. REPEAT wrapping on
	// uState makes the +offset/uN sampling implement the torus for free.
	for (int dy = -uR; dy <= uR; dy++) {
		for (int dx = -uR; dx <= uR; dx++) {
			float w = texelFetch(uKernel, ivec2(dx + uR, dy + uR), 0).r;
			if (w == 0.0) continue;
			u += w * texture(uState, vUV + vec2(float(dx), float(dy)) / uN).r;
		}
	}
	float a = texture(uState, vUV).r;
	float d = (u - uMu) / uSigma;
	float g = 2.0 * exp(-0.5 * d * d) - 1.0;
	outColor = vec4(clamp(a + uDt * g, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

const SPLAT_FRAG = `#version 300 es
precision highp float;
// Brush: paint (or erase) a soft Gaussian dab into the state texture.
// Torus-aware distance so painting across an edge wraps like the world does.
uniform sampler2D uState;
uniform float uN;
uniform vec2 uCenter;        // dab center in cells
uniform float uRadius;       // dab radius in cells
uniform float uAmp;          // + paints, - erases
in vec2 vUV;
out vec4 outColor;
void main() {
	vec2 p = vUV * uN;
	vec2 d = abs(p - uCenter);
	d = min(d, uN - d);      // shortest torus distance per axis
	float r2 = dot(d, d) / (uRadius * uRadius);
	float a = texture(uState, vUV).r;
	float dab = uAmp * exp(-3.0 * r2) * step(r2, 1.0);
	outColor = vec4(clamp(a + dab, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

const DISPLAY_FRAG = `#version 300 es
precision highp float;
// Map state to color. Manual bilinear tap: the state texture is NEAREST
// (float-linear filtering is an optional extension we don't require), so we
// blend the 4 neighbors ourselves — smooth zoom without a driver dependency.
uniform sampler2D uState;
uniform float uN;
uniform int uPalette;
in vec2 vUV;
out vec4 outColor;

float bilinear(vec2 uv) {
	vec2 p = uv * uN - 0.5;
	vec2 f = fract(p);
	vec2 base = (floor(p) + 0.5) / uN;    // texel centers; REPEAT wraps edges
	float tl = texture(uState, base).r;
	float tr = texture(uState, base + vec2(1.0 / uN, 0.0)).r;
	float bl = texture(uState, base + vec2(0.0, 1.0 / uN)).r;
	float br = texture(uState, base + vec2(1.0 / uN)).r;
	return mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
}

// Palettes are small hand-tuned ramps, not decorative gradients: value 0 must
// read as "empty water" (near-page-background) so creatures appear to swim in
// the page, and the top end must stay readable against the accent UI.
vec3 palette(float v) {
	if (uPalette == 1) {          // ember — warm alternative
		return vec3(pow(v, 0.9), pow(v, 1.8) * 0.75, pow(v, 3.5) * 0.4);
	} else if (uPalette == 2) {   // specimen — clinical grayscale
		return vec3(pow(v, 1.1));
	}
	// abyss (default) — deep teal into bioluminescent green into pale foam
	vec3 deep  = vec3(0.008, 0.024, 0.031);
	vec3 mid   = vec3(0.055, 0.38, 0.33);
	vec3 glow  = vec3(0.435, 0.89, 0.64);
	vec3 foam  = vec3(0.88, 1.0, 0.93);
	vec3 c = mix(deep, mid, smoothstep(0.0, 0.45, v));
	c = mix(c, glow, smoothstep(0.35, 0.8, v));
	c = mix(c, foam, smoothstep(0.78, 1.0, v));
	return c;
}
void main() {
	outColor = vec4(palette(bilinear(vUV)), 1.0);
}`;

// Compile a shader or throw with the driver's log — a silent shader failure
// would render black and look like a dead world.
function compile(gl, type, src) {
	const sh = gl.createShader(type);
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
		throw new Error('shader compile: ' + gl.getShaderInfoLog(sh));
	}
	return sh;
}

function link(gl, fragSrc) {
	const prog = gl.createProgram();
	gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
	gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
	gl.linkProgram(prog);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
		throw new Error('program link: ' + gl.getProgramInfoLog(prog));
	}
	return prog;
}

export class GlEngine {
	// Receives: canvas — the display <canvas>,
	//           n — world size in cells (256 for the page),
	//           params — { R, T, mu, sigma, beta } like CpuSim.
	// Throws Error with a human-readable message if WebGL2/float rendering
	// is unavailable — main.js shows it in place of the canvas.
	constructor(canvas, n, params) {
		this.canvas = canvas;
		this.n = n;
		const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
		if (!gl) throw new Error('This explorable needs WebGL2, which this browser doesn’t offer.');
		this.gl = gl;

		// Pick a renderable float format: R32F if the driver renders to full
		// float, else R16F via the half-float extension. Half precision (10
		// mantissa bits ~ 3 decimal digits) is adequate for dt >= 0.1 updates.
		if (gl.getExtension('EXT_color_buffer_float')) {
			this.fmt = { internal: gl.R32F, type: gl.FLOAT };
		} else if (gl.getExtension('EXT_color_buffer_half_float')) {
			this.fmt = { internal: gl.R16F, type: gl.HALF_FLOAT };
		} else {
			throw new Error('This explorable needs float-texture rendering '
				+ '(EXT_color_buffer_float), which this GPU/browser combination doesn’t offer.');
		}

		this.progStep = link(gl, STEP_FRAG);
		this.progSplat = link(gl, SPLAT_FRAG);
		this.progDisplay = link(gl, DISPLAY_FRAG);

		// State ping-pong pair + their framebuffers.
		this.tex = [this.makeStateTex(), this.makeStateTex()];
		this.fbo = [gl.createFramebuffer(), gl.createFramebuffer()];
		for (let i = 0; i < 2; i++) {
			gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[i]);
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex[i], 0);
			const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
			if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete: 0x' + st.toString(16));
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		this.src = 0;                  // index of the current-state texture

		this.kernelTex = gl.createTexture();
		this.setSpecies(params);       // uploads kernel, sets R/T/mu/sigma
		this.palette = 0;
		this.clear();
	}

	makeStateTex() {
		const { gl, n } = this;
		const t = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, t);
		// REPEAT wrap is what makes the world a torus in the step shader.
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texImage2D(gl.TEXTURE_2D, 0, this.fmt.internal, n, n, 0, gl.RED, this.fmt.type, null);
		return t;
	}

	// Switch species: new kernel (R, beta) + growth params + clock. Kernel
	// weights are float64 from buildKernel; the texture takes float32 — the
	// ~1e-8 rounding is far below dynamical significance (QA parity budget).
	setSpecies({ R, T, mu, sigma, beta }) {
		const { gl } = this;
		this.R = R; this.T = T; this.mu = mu; this.sigma = sigma; this.beta = beta.slice();
		const k = buildKernel(R, beta);
		gl.bindTexture(gl.TEXTURE_2D, this.kernelTex);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		// R32F upload for sampling is core WebGL2 (only RENDERING to float
		// needs the extension), so the kernel is always full precision.
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, k.size, k.size, 0, gl.RED, gl.FLOAT,
			Float32Array.from(k.weights));
	}

	setParams({ mu, sigma }) {
		if (mu !== undefined) this.mu = mu;
		if (sigma !== undefined) this.sigma = sigma;
	}

	// Overwrite the whole world from a Float32Array(n*n) — used by reset-to-
	// seed, parity probes, and clear.
	writeWorld(data) {
		const { gl, n } = this;
		gl.bindTexture(gl.TEXTURE_2D, this.tex[this.src]);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, n, gl.RED, this.fmt.type,
			this.fmt.type === gl.FLOAT ? data : toHalf(data));
	}

	// Stamp a decoded creature (cells from rle.js) at cell (cx, cy).
	// Torus wrap is handled by splitting the patch at the edges — up to 4
	// texSubImage2D calls. REPLACE semantics to match CpuSim.placeCells.
	placeCells(cells, cx, cy) {
		const { gl, n } = this;
		cx = ((cx % n) + n) % n; cy = ((cy % n) + n) % n;
		gl.bindTexture(gl.TEXTURE_2D, this.tex[this.src]);
		const w1 = Math.min(cells.w, n - cx), h1 = Math.min(cells.h, n - cy);
		const parts = [
			{ dx: cx, dy: cy, sx: 0, sy: 0, w: w1, h: h1 },
			{ dx: 0, dy: cy, sx: w1, sy: 0, w: cells.w - w1, h: h1 },
			{ dx: cx, dy: 0, sx: 0, sy: h1, w: w1, h: cells.h - h1 },
			{ dx: 0, dy: 0, sx: w1, sy: h1, w: cells.w - w1, h: cells.h - h1 },
		];
		for (const p of parts) {
			if (p.w <= 0 || p.h <= 0) continue;
			const patch = new Float32Array(p.w * p.h);
			for (let y = 0; y < p.h; y++) {
				for (let x = 0; x < p.w; x++) {
					patch[y * p.w + x] = cells.data[(p.sy + y) * cells.w + (p.sx + x)];
				}
			}
			gl.texSubImage2D(gl.TEXTURE_2D, 0, p.dx, p.dy, p.w, p.h, gl.RED, this.fmt.type,
				this.fmt.type === gl.FLOAT ? patch : toHalf(patch));
		}
	}

	clear() {
		this.writeWorld(new Float32Array(this.n * this.n));
	}

	// Run `count` simulation steps (ping-ponging the state pair).
	step(count = 1) {
		const { gl, n } = this;
		gl.useProgram(this.progStep);
		gl.viewport(0, 0, n, n);
		const loc = (name) => gl.getUniformLocation(this.progStep, name);
		gl.uniform1f(loc('uN'), n);
		gl.uniform1i(loc('uR'), this.R);
		gl.uniform1f(loc('uDt'), 1 / this.T);
		gl.uniform1f(loc('uMu'), this.mu);
		gl.uniform1f(loc('uSigma'), this.sigma);
		gl.uniform1i(loc('uState'), 0);
		gl.uniform1i(loc('uKernel'), 1);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.kernelTex);
		for (let i = 0; i < count; i++) {
			const dst = 1 - this.src;
			gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[dst]);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, this.tex[this.src]);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
			this.src = dst;
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	}

	// Brush dab at cell coords (paint if amp>0, erase if amp<0).
	splat(cx, cy, radius, amp) {
		const { gl, n } = this;
		gl.useProgram(this.progSplat);
		gl.viewport(0, 0, n, n);
		const loc = (name) => gl.getUniformLocation(this.progSplat, name);
		gl.uniform1f(loc('uN'), n);
		gl.uniform2f(loc('uCenter'), cx, cy);
		gl.uniform1f(loc('uRadius'), radius);
		gl.uniform1f(loc('uAmp'), amp);
		gl.uniform1i(loc('uState'), 0);
		const dst = 1 - this.src;
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[dst]);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.tex[this.src]);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		this.src = dst;
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	}

	// Draw the current state to the visible canvas.
	draw() {
		const { gl, canvas } = this;
		// Match the drawing buffer to the CSS size * devicePixelRatio so the
		// manual-bilinear display stays crisp on hidpi screens.
		const dpr = window.devicePixelRatio || 1;
		const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
		if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
		gl.useProgram(this.progDisplay);
		gl.viewport(0, 0, w, h);
		const loc = (name) => gl.getUniformLocation(this.progDisplay, name);
		gl.uniform1f(loc('uN'), this.n);
		gl.uniform1i(loc('uPalette'), this.palette);
		gl.uniform1i(loc('uState'), 0);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.tex[this.src]);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	// Read the current world back as Float32Array(n*n) — QA parity probe.
	// RGBA/FLOAT readback is the widely-supported path for float attachments;
	// we extract the R channel.
	readWorld() {
		const { gl, n } = this;
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.src]);
		const buf = new Float32Array(n * n * 4);
		gl.readPixels(0, 0, n, n, gl.RGBA, gl.FLOAT, buf);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		const out = new Float32Array(n * n);
		for (let i = 0; i < n * n; i++) out[i] = buf[i * 4];
		return out;
	}
}

// Float32 -> IEEE 754 half-float conversion for the R16F fallback path.
// Straight bit manipulation; handles normals/denormals/clamp, good enough
// for values in [0,1]. Exported so the test suite can pin the bit patterns
// directly (test/engine-half.test.js) without a GPU.
export function toHalf(f32) {
	const out = new Uint16Array(f32.length);
	const f = new Float32Array(1);
	const u = new Uint32Array(f.buffer);
	for (let i = 0; i < f32.length; i++) {
		f[0] = f32[i];
		const x = u[0];
		const sign = (x >> 16) & 0x8000;
		let exp = ((x >> 23) & 0xff) - 127 + 15;
		let mant = (x >> 13) & 0x3ff;
		if (exp <= 0) { out[i] = sign; }                     // flush denormals to 0
		else if (exp >= 31) { out[i] = sign | 0x7bff; }      // clamp to max half
		else { out[i] = sign | (exp << 10) | mant; }
	}
	return out;
}
