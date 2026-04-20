/**
 * detail.js — Image detail page behaviour
 *
 * Handles three independent concerns for gallery detail pages:
 *   1. OpenSeadragon (OSD) lightbox — deep zoom viewer with annotations
 *   2. Keyboard navigation — arrow keys, zoom, escape inside the lightbox
 *   3. Aladin Lite sky atlas — lazy-loaded via IntersectionObserver
 *
 * Template data is passed via a <script id="image-data" type="application/json">
 * block in image.njk. This file reads that JSON at script execution time (the
 * script is loaded with `defer`, which runs after parsing but before
 * DOMContentLoaded) and passes the parsed object to each init function. This
 * keeps Nunjucks template syntax entirely out of the JavaScript file.
 *
 * Phase 3: the JSON bridge now contains a `variants` array. Each variant has
 * its own DZI URL, annotations, and sky coordinates. The lightbox is shared
 * across all variants — the zoom trigger's `data-variant` attribute tells
 * detail.js which variant's tiles to load.
 *
 * Loaded with `defer` — runs after the DOM is parsed, before DOMContentLoaded fires.
 */

(function () {
	'use strict';

	// ── Read the JSON data bridge ─────────────────────────────────────────────
	// The <script type="application/json"> block is rendered by Nunjucks in image.njk.
	// It contains per-variant data: DZI URLs, annotations, sky coordinates, etc.
	var dataEl = document.getElementById('image-data');
	if (!dataEl) return;

	var data;
	try {
		data = JSON.parse(dataEl.textContent);
	} catch (e) {
		// If the JSON is malformed, bail — the page still renders static content,
		// but lightbox/aladin/comparison-slider interactivity will be unavailable.
		// Log the error so developers can diagnose template issues.
		console.error('detail.js: failed to parse #image-data JSON', e);
		// Belt-and-braces user-facing message (issue #85): the dev console is
		// invisible to a visitor, and a single dumpSafe regression in the
		// template can disable every detail page at once. Surface a small
		// status note next to the affected interactive features so the user
		// (or you on mobile) knows the failure is real and reload-fixable.
		try {
			var brokenTargets = document.querySelectorAll(
				'.zoom-trigger, .aladin-lite-container, .comparison-slider'
			);
			if (brokenTargets.length) {
				var notice = document.createElement('div');
				notice.setAttribute('role', 'status');
				notice.setAttribute('aria-live', 'polite');
				notice.style.cssText = 'padding:0.75rem;background:rgba(160,40,40,0.15);border-left:3px solid #c44;color:#eee;margin:1rem 0;font-size:0.875rem;';
				notice.textContent = 'Interactive features unavailable on this page — please reload.';
				// Insert before the first broken-feature element so it's seen
				// in context rather than orphaned at the top of the document.
				var first = brokenTargets[0];
				if (first.parentNode) first.parentNode.insertBefore(notice, first);
			}
		} catch (insertErr) {
			// If even this fails (DOM not ready, etc.), there's nothing more
			// to do — the console.error above is the only signal left.
		}
		return;
	}

	// Pull the variants array from the bridge. Each entry has:
	//   id, dziUrl, annotatedDziUrl, annotations[], sky (or null)
	var variants = data.variants || [];
	if (!variants.length) return;

	// Build a lookup map: variant ID → variant data object.
	// Used by the lightbox to find the right DZI/annotations when a
	// zoom trigger is clicked (reads data-variant from the button).
	var variantMap = {};
	variants.forEach(function (v) {
		variantMap[v.id] = v;
	});

	// ── Initialize each concern ───────────────────────────────────────────────
	// Lightbox: only if at least one variant has DZI tiles
	var hasAnyDzi = variants.some(function (v) { return v.dziUrl; });
	if (hasAnyDzi) {
		initLightbox(variantMap);
	}

	// Aladin: one sky atlas per variant that has sky data.
	// Each variant's sky object includes a containerId pointing to its
	// unique <div> in the template (e.g. "aladin-default", "aladin-narrowfield").
	variants.forEach(function (variant) {
		if (variant.sky) {
			initAladin(variant.sky);
		}
	});

	// Comparison sliders: initialize any before/after revision sliders on the page.
	// The slider containers are rendered by Nunjucks when a variant has 2+ revisions
	// with preview_url set. The JS reads data attributes and builds the interactive DOM.
	initComparisonSliders();


	// ═══════════════════════════════════════════════════════════════════════════
	//  LIGHTBOX — OpenSeadragon deep zoom viewer
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * initLightbox — sets up the full-viewport OSD lightbox.
	 *
	 * Receives the variant lookup map so it can resolve any variant's data
	 * by ID. Multiple zoom triggers on the page (.zoom-trigger buttons) each
	 * carry a data-variant attribute. Clicking one opens the lightbox with
	 * that variant's DZI tiles and annotations.
	 *
	 * Phase 4 additions: when a variant has revisions (multiple processing
	 * versions of the same raw data), a filmstrip of revision buttons appears
	 * below the viewer. Clicking a revision button swaps the OSD tile source
	 * and updates the URL query parameter ?r=variantId:revisionId via
	 * history.replaceState. On page load, if ?r= is present, the lightbox
	 * auto-opens at that variant+revision.
	 *
	 * OSD is loaded lazily — it doesn't initialise until the first click.
	 * The lightbox covers 100vw × 100vh with body scroll locked.
	 * Escape key or the Close button dismisses it.
	 *
	 * @param {Object} variantMap - Map of variant ID → variant data
	 */
	function initLightbox(variantMap) {
		var lightbox   = document.getElementById('zoom-lightbox');
		var closeBtn   = document.getElementById('lightbox-close');
		var annotBtn   = document.getElementById('annotate-toggle');
		// objectsBtn is created dynamically as an OSD toolbar button (see below).
		// osdObjectsButton holds the OpenSeadragon.Button instance for cleanup;
		// objectsBtn points to its wrapper element for ARIA/class manipulation.
		var objectsBtn = null;
		var osdObjectsButton = null;

		// Revision filmstrip containers — rendered in image.njk, populated by JS
		var revisionStrip = document.getElementById('revision-strip');
		var revisionNote  = document.getElementById('revision-note');

		// All zoom triggers on the page — one per variant (or one at page hero for single-variant)
		var triggers = document.querySelectorAll('.zoom-trigger');

		if (!lightbox || !triggers.length) return;

		// OSD instance — created once on first open, reused on subsequent opens
		var viewer = null;

		// The variant whose tiles are currently loaded in the lightbox.
		// Updated every time the lightbox opens for a (possibly different) variant.
		var activeVariant = null;

		// The currently displayed revision object (from variant.revisions[]).
		// null when the variant has no revisions — the variant-level DZI is used directly.
		var activeRevision = null;

		// The zoom trigger button that opened the lightbox. Used to return
		// focus on close so keyboard users aren't stranded.
		var lastTrigger = null;

		// Annotation overlay elements for the current variant — div elements
		// positioned by OSD at the annotation's image coordinates.
		var annotationEls    = [];
		var showingObjects   = false;
		var showingAnnotated = false;

		// RA/Dec gridline canvas overlay. Created once per OSD viewer (lazy on
		// first variant with WCS), reused across variants. Visibility is bound
		// to showingObjects — the grid toggles together with the annotations
		// via the same Objects button. drawGrid is rebound to the active
		// variant's WCS each time addAnnotations runs.
		var gridCanvas      = null;
		var gridCtx         = null;
		var gridDrawHandler = null; // OSD event handler ref for cleanup
		var gridResizeHandler = null;
		// One-shot tracker: variants for which we've already warned about an
		// unusable WCS (every corner projects non-finite). Prevents flooding
		// console.warn during 60fps OSD animation events. Issue #90.
		var warnedUnusableWcsForVariant = Object.create(null);

		// Tracks whether the annotation "flash" has been shown. On the first
		// lightbox open for a variant with annotations, we briefly show the
		// overlays (2 seconds) then fade them out so users know they exist.
		// Only fires once per page session; does NOT touch the button state.
		var hasFlashedAnnotations = false;
		// Timer IDs for the flash timeout chain. Stored so clearAnnotations
		// can cancel them if the user switches variants mid-flash.
		var flashTimerA = null;
		var flashTimerB = null;

		// Flag to ensure annotBtn/objectsBtn listeners are registered only once.
		// Without this guard, an open-failed → viewer=null → reopen cycle re-runs
		// the if(!viewer) block and adds duplicate handlers on every reopen.
		var listenersRegistered = false;

		// ── Open lightbox ────────────────────────────────────────────────────

		/**
		 * Opens the lightbox for the specified variant, optionally at a specific revision.
		 *
		 * When the variant has revisions, a filmstrip of buttons appears below the
		 * OSD viewer. The default revision is whichever has is_final: true (or the
		 * first one if none is marked final). Passing revisionId overrides this —
		 * used when restoring state from the ?r= URL parameter.
		 *
		 * @param {string} variantId   - The variant ID (from data-variant attribute)
		 * @param {HTMLElement} triggerEl - The button that was clicked (for focus return)
		 * @param {string} [revisionId]  - Optional revision ID to open directly
		 */
		function openLightbox(variantId, triggerEl, revisionId) {
			var variant = variantMap[variantId];
			if (!variant || !variant.dziUrl) return;

			activeVariant = variant;
			lastTrigger   = triggerEl;
			lightbox.hidden = false;

			// Lock page scroll so the user can't accidentally scroll
			// the page while panning inside the lightbox
			document.body.style.overflow = 'hidden';

			// ── Determine which revision to show (if any) ────────────────
			// Revisions are optional — most variants have none. When present,
			// the revision's DZI overrides the variant-level DZI in the viewer.
			var revisions = variant.revisions || [];
			activeRevision = null;

			if (revisions.length > 0) {
				if (revisionId) {
					// Caller requested a specific revision (e.g. from ?r= URL param).
					// Array.find isn't used here — forEach works in older browsers.
					revisions.forEach(function (r) {
						if (r.id === revisionId) activeRevision = r;
					});
				}
				if (!activeRevision) {
					// Default: the revision marked is_final, or first in the array.
					// is_final means this is the most recent/best processing version.
					revisions.forEach(function (r) {
						if (r.is_final && !activeRevision) activeRevision = r;
					});
					if (!activeRevision) activeRevision = revisions[0];
				}
			}

			// The DZI to open: revision-level if available, otherwise variant-level
			var dziToOpen = activeRevision ? activeRevision.dzi_url : variant.dziUrl;

			// Show/hide annotation buttons based on this variant's data.
			// Different variants may have different annotated DZIs and object labels.
			// When viewing a specific revision, use that revision's annotated DZI
			// (falls back to variant-level if the revision doesn't have one).
			var currentAnnotatedDzi = activeRevision
				? (activeRevision.annotated_dzi_url || variant.annotatedDziUrl)
				: variant.annotatedDziUrl;

			if (annotBtn) {
				annotBtn.hidden = !currentAnnotatedDzi;
			}
			// objectsBtn visibility is managed after OSD creates it (see below)

			// Reset annotation toggle state for the new variant
			showingAnnotated = false;
			showingObjects   = false;
			if (annotBtn) {
				annotBtn.textContent = 'Show Annotations';
				annotBtn.setAttribute('aria-pressed', 'false');
			}

			// ── Render revision filmstrip ─────────────────────────────────
			renderFilmstrip(variant, activeRevision);

			// ── Update URL state ─────────────────────────────────────────
			updateUrlState(variantId, activeRevision);

			if (!viewer) {
				// ── First open: create the OSD viewer ────────────────────────

				// Guard: if the CDN script failed to load, OpenSeadragon won't exist.
				// Without this check, the constructor throws a ReferenceError and the
				// user sees a blank black lightbox with no explanation.
				if (typeof OpenSeadragon === 'undefined') {
					var errDiv = document.createElement('div');
					errDiv.className = 'osd-error';
					errDiv.textContent = 'Deep zoom viewer failed to load. Please refresh or try again later.';
					var container = document.getElementById('osd-viewer');
					container.textContent = '';
					container.appendChild(errDiv);
					return;
				}

				viewer = OpenSeadragon({
					id: 'osd-viewer',
					prefixUrl: 'https://cdn.jsdelivr.net/npm/openseadragon@6.0.2/build/openseadragon/images/',
					tileSources: dziToOpen,

					// Minimap
					showNavigator:       true,
					navigatorPosition:   'BOTTOM_RIGHT',
					navigatorSizeRatio:  0.12,

					// CORS required for R2-hosted tiles (different origin from the page)
					crossOriginPolicy: 'Anonymous',

					showZoomControl:     true,
					showHomeControl:     true,
					showFullPageControl: false,  // we ARE the fullscreen; redundant here
					showRotationControl: false,

					animationTime: 0.4,
					blendTime:     0.1,

					// Default zoomPerClick is 2.0 (doubles/halves each press — too jumpy).
					// 1.4 zooms by 40% per button click, which feels gradual and controlled.
					// zoomPerScroll controls the mouse wheel step; 1.15 is slightly finer
					// than the default 1.2 to match the more precise button feel.
					zoomPerClick:  1.4,
					zoomPerScroll: 1.15,

					// Fit the whole image on first load
					defaultZoomLevel: 0,

					gestureSettingsMouse: {
						scrollToZoom:   true,
						clickToZoom:    false,
						dblClickToZoom: true,
						dragToPan:      true,
					},
					gestureSettingsTouch: {
						pinchToZoom:  true,
						dragToPan:    true,
						flickEnabled: true,
					},

					maxImageCacheCount: 300,
				});

				// Block right-click save on the canvas
				document.getElementById('osd-viewer').addEventListener('contextmenu', function (e) {
					e.preventDefault();
				});

				// ── Coordinate readout + zoom indicator ─────────────────────
				// Shows RA/Dec of the cursor position and zoom percentage in a
				// small overlay at the bottom-left of the lightbox. Only active
				// when the variant has sky data (raDeg, decDeg, fovW, fovH).
				setupCoordOverlay();

				// Tile load error — reset viewer so the next openLightbox() call
				// reinitialises OSD. Also reset annotation/toggle state so the
				// buttons don't appear stuck in their last state after recovery.
				viewer.addHandler('open-failed', function () {
					var el = document.getElementById('osd-viewer');
					viewer.destroy();
					viewer = null;
					clearAnnotations();
					showingAnnotated = false;
					if (annotBtn) {
						annotBtn.textContent = 'Show Annotations';
						annotBtn.setAttribute('aria-pressed', 'false');
					}
					showingObjects = false;
					objectsBtn = null;        // wrapper element gone with viewer
					osdObjectsButton = null;  // OSD Button instance gone with viewer
					var errEl = document.createElement('div');
					errEl.className = 'osd-error';
					errEl.textContent = 'Could not load image tiles. Check that the DZI file and tile folder are uploaded to R2.';
					el.textContent = '';
					el.appendChild(errEl);
				});

				// After the first tile set loads, add annotation overlays
				// for the initial variant.
				viewer.addOnceHandler('open', function () {
					addAnnotations(variant);
					setupObjectsButton(variant);
					flashAnnotations(variant);
				});

			} else {
				// ── Subsequent open: switch tile source if variant changed ────
				// Clear previous variant's annotations, then load new tiles.
				// addAnnotations() runs after the new source is ready.
				// Uses dziToOpen which accounts for the active revision.
				clearAnnotations();
				viewer.open(dziToOpen);
				viewer.addOnceHandler('open', function () {
					addAnnotations(variant);
					setupObjectsButton(variant);
					flashAnnotations(variant);
				});
			}

			// ── Register click handlers once ─────────────────────────────────
			// Kept outside the if(!viewer) block so an open-failed → viewer=null →
			// reopen cycle does not add duplicate listeners on each reopen.
			if (!listenersRegistered) {
				listenersRegistered = true;

				// Tile-source annotation toggle — swaps between the clean and
				// annotated DZI tile sets for the currently active variant/revision.
				// When a revision is active, uses the revision's annotated DZI
				// (falling back to the variant-level one if the revision lacks it).
				if (annotBtn) {
					annotBtn.addEventListener('click', function () {
						if (!viewer || !activeVariant) return;
						showingAnnotated = !showingAnnotated;

						// Resolve the correct clean and annotated DZI URLs.
						// If viewing a specific revision, prefer its URLs over the variant's.
						var cleanDzi = activeRevision
							? (activeRevision.dzi_url || activeVariant.dziUrl)
							: activeVariant.dziUrl;
						var annotDzi = activeRevision
							? (activeRevision.annotated_dzi_url || activeVariant.annotatedDziUrl)
							: activeVariant.annotatedDziUrl;

						viewer.open(showingAnnotated ? annotDzi : cleanDzi);
						annotBtn.textContent = showingAnnotated ? 'Hide Annotations' : 'Show Annotations';
						annotBtn.setAttribute('aria-pressed', showingAnnotated ? 'true' : 'false');
					});
				}

				// objectsBtn is now created as an OSD toolbar button inside
				// setupObjectsButton() — no separate listener registration needed.
			}

			// Return focus to close button for keyboard accessibility
			if (closeBtn) closeBtn.focus();
		}

		// ── WCS sky/pixel projection helpers ────────────────────────────────
		// Standard FITS tangent-plane projection using the CD matrix. Given a
		// variant.wcs object (populated by ingest's solveWithAstrometry), we
		// can convert sky ↔ image-fraction coordinates accurately, including
		// rotation (which the simpler sky.fovW/fovH approximation can't handle).
		//
		// All wcs fields are in the coordinate system of the preview WebP that
		// astrometry.net actually solved (variant.wcs.imgW/imgH). Annotations
		// stored as fractions are coordinate-system-independent, so the same
		// fractional positions render correctly on the higher-res DZI tiles.

		/**
		 * precomputeWcs — lazily attach cached projection invariants to a wcs.
		 *
		 * For a given variant, `cos(decDeg)` and `1/det(CD)` are constants —
		 * but skyToPixelFrac was recomputing them on every call (~360 times
		 * per drawGrid frame at 60fps during pan). Cache them once, keyed
		 * by the wcs object itself.
		 *
		 * Uses `Object.defineProperty` with `enumerable: false` so the
		 * cached `_*` fields don't leak into `JSON.stringify(activeVariant.wcs)`
		 * if a future logging or persistence path serializes it. Issue #82.
		 *
		 * Degenerate-CD-matrix handling: instead of letting `_invDet` become
		 * Infinity and silently poison every projection, set `_degenerate = true`.
		 * skyToPixelFrac checks that flag first and short-circuits to null,
		 * preserving the same contract the per-call guard had before.
		 *
		 * Idempotent — bails immediately on a wcs that's already been cached.
		 */
		function precomputeWcs(wcs) {
			if (!wcs || wcs._cached) return;
			var det = wcs.cd11 * wcs.cd22 - wcs.cd12 * wcs.cd21;
			var degenerate = !(Math.abs(det) >= 1e-20);
			Object.defineProperty(wcs, '_cached',     { value: true,                        enumerable: false });
			Object.defineProperty(wcs, '_degenerate', { value: degenerate,                  enumerable: false });
			if (degenerate) return;
			Object.defineProperty(wcs, '_cosDec', { value: Math.cos(wcs.decDeg * Math.PI / 180), enumerable: false });
			// Pre-divided CD-inverse entries so skyToPixelFrac drops to a
			// pair of multiplies + adds per coordinate.
			Object.defineProperty(wcs, '_inv00', { value:  wcs.cd22 / det, enumerable: false });
			Object.defineProperty(wcs, '_inv01', { value: -wcs.cd12 / det, enumerable: false });
			Object.defineProperty(wcs, '_inv10', { value: -wcs.cd21 / det, enumerable: false });
			Object.defineProperty(wcs, '_inv11', { value:  wcs.cd11 / det, enumerable: false });
		}

		/**
		 * skyToPixelFrac — sky (RA, Dec in degrees) → image fraction (0..1).
		 *
		 * Inverts the 2x2 CD matrix to convert sky offsets into pixel offsets
		 * from the reference pixel (crpix1, crpix2, FITS 1-indexed). The cos(dec)
		 * factor on dRA accounts for the foreshortening of RA lines toward the
		 * poles. Returns null if the matrix is degenerate (det ~ 0).
		 *
		 * @param {number} raDeg
		 * @param {number} decDeg
		 * @param {Object} wcs — variant.wcs from images.json (camelCased)
		 * @returns {{x:number, y:number} | null}
		 */
		function skyToPixelFrac(raDeg, decDeg, wcs) {
			precomputeWcs(wcs);
			if (wcs._degenerate) return null;

			var dRA = raDeg - wcs.raDeg;
			// Wrap to [-180, 180] so RA crossings near 0/360 don't blow up
			if (dRA > 180)  dRA -= 360;
			if (dRA < -180) dRA += 360;
			dRA *= wcs._cosDec;
			var dDec = decDeg - wcs.decDeg;

			// Use precomputed inverse-CD entries (issue #82).
			var dx = wcs._inv00 * dRA + wcs._inv01 * dDec;
			var dy = wcs._inv10 * dRA + wcs._inv11 * dDec;

			// FITS reference pixels are 1-indexed; subtract 1 for 0-based array math
			var xPx = (wcs.crpix1 - 1) + dx;
			var yPx = (wcs.crpix2 - 1) + dy;
			return { x: xPx / wcs.imgW, y: yPx / wcs.imgH };
		}

		/**
		 * pixelFracToSky — image fraction (0..1) → sky (RA, Dec in degrees).
		 *
		 * Forward CD matrix application. Inverse of skyToPixelFrac.
		 *
		 * @param {number} fx — fractional x position (0=left, 1=right)
		 * @param {number} fy — fractional y position (0=top, 1=bottom)
		 * @param {Object} wcs
		 * @returns {{ra:number, dec:number}}
		 */
		function pixelFracToSky(fx, fy, wcs) {
			precomputeWcs(wcs);
			var dx = fx * wcs.imgW - (wcs.crpix1 - 1);
			var dy = fy * wcs.imgH - (wcs.crpix2 - 1);
			var dRA  = wcs.cd11 * dx + wcs.cd12 * dy;
			var dDec = wcs.cd21 * dx + wcs.cd22 * dy;
			// Reuse precomputed cos(decDeg) when available; falls back to
			// fresh compute when the WCS is degenerate (no harm done; result
			// will be discarded by the caller's NaN check anyway).
			var cosDec = wcs._cosDec != null ? wcs._cosDec : Math.cos(wcs.decDeg * Math.PI / 180);
			return {
				ra:  wcs.raDeg + dRA / cosDec,
				dec: wcs.decDeg + dDec,
			};
		}

		// ── Gridline canvas overlay ─────────────────────────────────────────
		// Renders RA/Dec grid lines onto a transparent canvas overlaid on the
		// OSD viewer. Visibility is coupled to the Annotations toggle: same
		// button shows/hides both, both flash together on first lightbox open.
		//
		// Lines are sampled at 20 points each (drawn as polylines) so any
		// curvature from the tangent-plane projection at wide FOVs renders
		// smoothly. Grid spacing auto-picks a "nice" value (1', 5', 10', 30',
		// 1°, 2°, 5°, 10°) so 5–10 lines are visible at the current zoom.

		/**
		 * pickGridSpacing — choose a "nice" round grid spacing in degrees so
		 * that 5–10 lines are visible across the given range. Steps are 1', 2',
		 * 5', 10', 15', 30', 1°, 2°, 5°, 10° — the same intervals AstroBin and
		 * Stellarium use, so the result feels familiar.
		 *
		 * @param {number} rangeDeg — visible range in degrees (RA or Dec)
		 * @returns {number} spacing in degrees
		 */
		function pickGridSpacing(rangeDeg) {
			// Target ~10 visible lines across the current viewport range. More
			// than 7 (the previous default) gives denser grids that adapt to
			// narrow-FOV images without feeling sparse. At extreme zoom-in,
			// 0.5' and 1' steps catch the sub-arcminute regime; at wide-field,
			// 5°/10° keep the spacing readable.
			var rangeMin = rangeDeg * 60;
			var ideal = rangeMin / 10;
			var nice = [0.5, 1, 2, 5, 10, 15, 20, 30, 60, 90, 120, 180, 300, 600];
			for (var i = 0; i < nice.length; i++) {
				if (nice[i] >= ideal) return nice[i] / 60;
			}
			return nice[nice.length - 1] / 60;
		}

		/**
		 * setupGridCanvas — lazily create the grid canvas inside the OSD viewer
		 * container. Called from addAnnotations() the first time a variant with
		 * WCS opens. Hooks OSD's animation events so the grid redraws on every
		 * pan/zoom; hooks window resize so the canvas pixel buffer stays sized
		 * to the OSD container's CSS dimensions (with devicePixelRatio scaling
		 * for HiDPI screens).
		 */
		function setupGridCanvas() {
			if (gridCanvas || !viewer) return;
			var osdEl = document.getElementById('osd-viewer');
			if (!osdEl) return;

			gridCanvas = document.createElement('canvas');
			gridCanvas.className = 'osd-grid-canvas osd-annotation--hidden';
			gridCanvas.setAttribute('aria-hidden', 'true');
			// Append as the LAST child of #osd-viewer so the grid sits above
			// OSD's own .openseadragon-container in both DOM order and paint
			// order. OSD's container establishes a stacking context that
			// ignores external z-index, so DOM-order appending is the only
			// reliable way to overlay content on top of the rendered image.
			// Annotations are OSD overlays nested inside the container and
			// still paint correctly above the image; the grid just sits on
			// top of everything including those annotations (pointer-events
			// is none, so the grid doesn't intercept mouse events).
			osdEl.appendChild(gridCanvas);
			gridCtx = gridCanvas.getContext('2d');

			function resizeCanvas() {
				if (!gridCanvas || !osdEl) return;
				var rect = osdEl.getBoundingClientRect();
				var dpr  = window.devicePixelRatio || 1;
				// Pixel buffer scaled for HiDPI; CSS size matches container
				gridCanvas.width  = Math.round(rect.width  * dpr);
				gridCanvas.height = Math.round(rect.height * dpr);
				gridCanvas.style.width  = rect.width  + 'px';
				gridCanvas.style.height = rect.height + 'px';
				// setTransform so subsequent ctx ops use logical pixels
				gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
			}
			gridResizeHandler = resizeCanvas;
			resizeCanvas();
			window.addEventListener('resize', gridResizeHandler);

			// Redraw on every viewport change. 'animation' fires continuously
			// during pan/zoom; 'animation-finish' fires once when settled.
			gridDrawHandler = function () { drawGrid(); };
			viewer.addHandler('animation', gridDrawHandler);
			viewer.addHandler('animation-finish', gridDrawHandler);
			viewer.addHandler('resize', function () {
				resizeCanvas();
				drawGrid();
			});
		}

		/**
		 * skyToCanvasPoint — sky (RA, Dec) → canvas-pixel (x, y), composing
		 * skyToPixelFrac with OSD's image→viewport→window coord transforms.
		 * Returns null if the WCS projection is degenerate or OSD isn't ready.
		 *
		 * @param {number} raDeg
		 * @param {number} decDeg
		 * @param {Object} wcs
		 * @param {{x:number,y:number}} contentSize — OSD's getContentSize()
		 * @returns {{x:number, y:number} | null}
		 */
		function skyToCanvasPoint(raDeg, decDeg, wcs, contentSize) {
			var frac = skyToPixelFrac(raDeg, decDeg, wcs);
			if (!frac) return null;
			// Use OSD's number-overload of imageToViewportCoordinates to
			// skip allocating the input Point — saves one allocation per
			// call (~360 calls/frame). The two return Points still come
			// back from OSD; we extract their .x/.y immediately into the
			// returned plain object so they become eligible for GC at the
			// next yield. Issue #82.
			var vpPt = viewer.viewport.imageToViewportCoordinates(
				frac.x * contentSize.x,
				frac.y * contentSize.y
			);
			// pixelFromPoint returns position in OSD-container-relative
			// coordinates already (not screen-relative), so no rect.left
			// subtraction needed. This matches what OSD overlays use.
			var pixPt = viewer.viewport.pixelFromPoint(vpPt, true);
			return { x: pixPt.x, y: pixPt.y };
		}

		/**
		 * sampleSkyLine — sample N+1 evenly-spaced points along a sky line
		 * segment and return them as canvas-pixel positions. For the FOVs in
		 * the gallery (all under 4°), tangent-plane curvature is small but
		 * not zero — a sampled polyline produces smooth curves vs. the
		 * straight-line look of just-two-endpoints.
		 *
		 * Returned as {x,y}[] so the SAME sample set can be used for both the
		 * canvas path (strokePolyline) and the label-anchor search
		 * (findEdgeAnchor). That guarantees the label sits on the actual
		 * drawn line rather than at a re-projected point that may drift due
		 * to rotation/curvature.
		 */
		function sampleSkyLine(ra1, dec1, ra2, dec2, wcs, contentSize, samples) {
			samples = samples || 20;
			var points = [];
			for (var i = 0; i <= samples; i++) {
				var t = i / samples;
				var ra  = ra1  + (ra2  - ra1)  * t;
				var dec = dec1 + (dec2 - dec1) * t;
				var pt = skyToCanvasPoint(ra, dec, wcs, contentSize);
				if (pt) points.push(pt);
			}
			return points;
		}

		/**
		 * strokePolyline — append a polyline to the current canvas path.
		 * Caller owns beginPath/stroke so many lines can share one path and
		 * get stroked in two passes (dark halo + cyan).
		 */
		function strokePolyline(points) {
			if (points.length < 2) return;
			gridCtx.moveTo(points[0].x, points[0].y);
			for (var i = 1; i < points.length; i++) {
				gridCtx.lineTo(points[i].x, points[i].y);
			}
		}

		/**
		 * findEdgeAnchor — find the point in a polyline closest to one edge
		 * of the clip rect, considering only points that lie inside the rect.
		 * Used to anchor a grid label to where its line actually enters the
		 * image (not where a straight line would cross, which can differ by
		 * tens of pixels on rotated fields).
		 *
		 * @param {{x:number,y:number}[]} points
		 * @param {{x:number,y:number,w:number,h:number}} clip
		 * @param {'top'|'left'|'bottom'|'right'} edge
		 * @returns {{x:number,y:number}|null}
		 */
		function findEdgeAnchor(points, clip, edge) {
			var best = null, bestDist = Infinity;
			for (var i = 0; i < points.length; i++) {
				var p = points[i];
				// Only consider points strictly inside the visible image rect.
				if (p.x < clip.x || p.x > clip.x + clip.w) continue;
				if (p.y < clip.y || p.y > clip.y + clip.h) continue;
				var d;
				if      (edge === 'top')    d = p.y - clip.y;
				else if (edge === 'left')   d = p.x - clip.x;
				else if (edge === 'bottom') d = (clip.y + clip.h) - p.y;
				else                        d = (clip.x + clip.w) - p.x;
				if (d < bestDist) { best = p; bestDist = d; }
			}
			return best;
		}

		/**
		 * drawLabelAtEdge — AstroBin-style axis label: short tick mark at the
		 * grid-line/edge intersection, plus a semi-transparent dark box with
		 * the RA or Dec value. The dark box is essential — at 12px the cyan
		 * text vanishes against bright nebulosity without a solid backing.
		 *
		 * anchorX / anchorY is the point ON the grid line inside the image,
		 * NOT on the clip edge — the tick is drawn from there toward the edge
		 * and the label is placed just inside the edge with a small offset
		 * along the line direction so consecutive labels don't stack up.
		 *
		 * @param {string} text       label text (e.g. "5h30m")
		 * @param {number} anchorX    x of the point on the line we're labeling
		 * @param {number} anchorY    y of the point on the line we're labeling
		 * @param {{x:number,y:number,w:number,h:number}} clip
		 * @param {'top'|'left'} edge  which edge to label on
		 */
		function drawLabelAtEdge(text, anchorX, anchorY, clip, edge) {
			var metrics = gridCtx.measureText(text);
			var tw = Math.ceil(metrics.width);
			var th = 12;       // font pixel size
			var padX = 4, padY = 2;
			var tickLen = 6;
			var bx, by, tx1, ty1, tx2, ty2;

			if (edge === 'top') {
				// Tick: from the edge inward, at anchor's x
				tx1 = anchorX;           ty1 = clip.y;
				tx2 = anchorX;           ty2 = clip.y + tickLen;
				// Box: to the right of the tick, just inside the top edge
				bx = anchorX + 3;
				by = clip.y + 2;
				// Clamp box horizontally inside the clip so the label never
				// vanishes off the right edge for the rightmost grid line.
				var maxBx = clip.x + clip.w - (tw + padX * 2) - 2;
				if (bx > maxBx) bx = maxBx;
			} else { // 'left'
				tx1 = clip.x;            ty1 = anchorY;
				tx2 = clip.x + tickLen;  ty2 = anchorY;
				bx = clip.x + 3;
				by = anchorY - (th + padY * 2) - 1;
				var minBy = clip.y + 2;
				if (by < minBy) by = anchorY + 3; // fall below the tick near top corner
			}

			// Tick mark (drawn first so the label box overlaps its base cleanly)
			gridCtx.strokeStyle = 'rgba(180, 230, 235, 0.85)';
			gridCtx.lineWidth = 1.2;
			gridCtx.beginPath();
			gridCtx.moveTo(tx1, ty1);
			gridCtx.lineTo(tx2, ty2);
			gridCtx.stroke();

			// Dark backing box for guaranteed legibility over bright nebulosity.
			// Issue #86: bumped from 0.55 to 0.8 alpha so contrast stays
			// above WCAG 1.4.3 AA (4.5:1) when composited over bright
			// regions like Veil O3 wisps or galaxy cores.
			gridCtx.fillStyle = 'rgba(0, 0, 0, 0.8)';
			gridCtx.fillRect(bx, by, tw + padX * 2, th + padY * 2);

			// Cyan label
			gridCtx.fillStyle = 'rgba(180, 230, 235, 0.95)';
			gridCtx.fillText(text, bx + padX, by + padY);
		}

		/**
		 * formatRaShort / formatDecShort — compact axis labels for grid lines.
		 * Differs from setupCoordOverlay's full-precision formatters: drops
		 * seconds for shorter strings that don't crowd the canvas.
		 */
		function formatRaShort(raDeg) {
			var ra = ((raDeg % 360) + 360) % 360;
			var totalH = ra / 15;
			var h = Math.floor(totalH);
			var m = (totalH - h) * 60;
			return h + 'h' + (m < 10 ? '0' : '') + m.toFixed(1) + 'm';
		}
		function formatDecShort(decDeg) {
			var sign = decDeg < 0 ? '\u2212' : '+';
			var abs = Math.abs(decDeg);
			var d = Math.floor(abs);
			var m = (abs - d) * 60;
			return sign + d + '\u00b0' + (m < 10 ? '0' : '') + m.toFixed(1) + '\u2032';
		}

		/**
		 * drawGrid — recompute and render the RA/Dec grid for the current
		 * viewport. Bails out cleanly if WCS or viewer aren't ready.
		 *
		 * Algorithm:
		 *   1. Get the visible image-pixel bounds from OSD's viewport.
		 *   2. Project the four corners back to sky (RA/Dec).
		 *   3. Pick a "nice" grid spacing for both axes.
		 *   4. Draw constant-RA lines (sample 20 points each) and labels.
		 *   5. Draw constant-Dec lines and labels.
		 *
		 * Cost: ~50 line draws + sampling per redraw. OSD pan/zoom can fire
		 * 'animation' at 60fps — drawing 20-point polylines via canvas2d on a
		 * laptop is well under 1ms, so no throttling needed.
		 */
		function drawGrid() {
			if (!gridCanvas || !gridCtx || !viewer || !activeVariant) return;
			if (!activeVariant.wcs) return;

			var wcs = activeVariant.wcs;
			var item = viewer.world.getItemAt(0);
			if (!item) return;
			var contentSize = item.getContentSize();

			// Clear the full canvas first (DPR-scaled ctx means we use logical px)
			var dpr = window.devicePixelRatio || 1;
			gridCtx.clearRect(0, 0, gridCanvas.width / dpr, gridCanvas.height / dpr);

			// ── Clip to image bounds ────────────────────────────────────────
			// Grid should only render WITHIN the actual image rectangle, never
			// in the black letterbox bars where the image doesn't fill the
			// viewport. getItemAt(0).getBounds() returns the image's position
			// in viewport coords — convert to canvas pixels via pixelFromPoint.
			var imgViewport = item.getBounds(true);
			var imgTopLeft = viewer.viewport.pixelFromPoint(
				new OpenSeadragon.Point(imgViewport.x, imgViewport.y), true);
			var imgBotRight = viewer.viewport.pixelFromPoint(
				new OpenSeadragon.Point(imgViewport.x + imgViewport.width,
				                        imgViewport.y + imgViewport.height), true);
			// Image bounding rect on the canvas, intersected with visible viewport
			// (no point drawing off-canvas).
			var clipX = Math.max(0, imgTopLeft.x);
			var clipY = Math.max(0, imgTopLeft.y);
			var clipW = Math.min(gridCanvas.width / dpr, imgBotRight.x) - clipX;
			var clipH = Math.min(gridCanvas.height / dpr, imgBotRight.y) - clipY;
			if (clipW <= 0 || clipH <= 0) return; // image entirely off-screen

			gridCtx.save();
			gridCtx.beginPath();
			gridCtx.rect(clipX, clipY, clipW, clipH);
			gridCtx.clip();

			// ── Compute visible sky range ────────────────────────────────────
			// Use the INTERSECTION of image bounds + viewport bounds, not just
			// the viewport — avoids picking a spacing based on letterbox area.
			// Visible image-pixel bounds: clamp the viewport to the image rect.
			var bounds = viewer.viewport.getBounds(true);
			var topLeftVp  = new OpenSeadragon.Point(
				Math.max(bounds.x, imgViewport.x),
				Math.max(bounds.y, imgViewport.y));
			var botRightVp = new OpenSeadragon.Point(
				Math.min(bounds.x + bounds.width,  imgViewport.x + imgViewport.width),
				Math.min(bounds.y + bounds.height, imgViewport.y + imgViewport.height));
			var topLeftIm  = viewer.viewport.viewportToImageCoordinates(topLeftVp);
			var botRightIm = viewer.viewport.viewportToImageCoordinates(botRightVp);

			// Convert all 4 corners to sky. Use min/max to find the bounding
			// box of (potentially-rotated) sky region currently visible.
			var corners = [
				pixelFracToSky(topLeftIm.x  / contentSize.x, topLeftIm.y  / contentSize.y, wcs),
				pixelFracToSky(botRightIm.x / contentSize.x, topLeftIm.y  / contentSize.y, wcs),
				pixelFracToSky(topLeftIm.x  / contentSize.x, botRightIm.y / contentSize.y, wcs),
				pixelFracToSky(botRightIm.x / contentSize.x, botRightIm.y / contentSize.y, wcs),
			];

			// Detect malformed WCS: every corner returns non-finite RA/Dec
			// means the CD matrix can't be inverted. drawGrid would then
			// silently paint nothing, with the user just seeing an empty
			// "Show Objects" button. One-shot console.warn so the failure
			// surfaces in DevTools without flooding the 60fps redraw loop.
			// Issue #90.
			var allNonFinite = corners.every(function (c) {
				return !c || !Number.isFinite(c.ra) || !Number.isFinite(c.dec);
			});
			if (allNonFinite) {
				var slug = activeVariant.slug || 'unknown';
				if (!warnedUnusableWcsForVariant[slug]) {
					warnedUnusableWcsForVariant[slug] = true;
					console.warn(
						'drawGrid: WCS for variant "' + slug + '" is unusable ' +
						'(all 4 corners projected to non-finite RA/Dec). Grid + label overlay will be empty. ' +
						'Likely a degenerate CD matrix from the plate solve.'
					);
				}
				return; // bail; later guards would silently skip everything anyway
			}

			var ras  = corners.map(function (c) { return c.ra;  });
			var decs = corners.map(function (c) { return c.dec; });
			var decMin = Math.min.apply(null, decs), decMax = Math.max.apply(null, decs);

			// ── RA wraparound handling (issue #80) ───────────────────────────
			// For fields crossing RA=0h/24h, raw corner RA values come back as
			// e.g. {359.5, 0.5, 359.2, 0.8}. A naive Math.min/max gives
			// raMin≈0.5, raMax≈359.5 — pickGridSpacing then picks 10° and
			// the loop draws ~36 lines across the entire sky. Detect the wrap
			// case and shift sub-180° corners by +360° so the range becomes
			// contiguous; emitted RA values are unwrapped mod 360 in
			// formatRaShort. One-shot console.warn so a heuristic-pick error
			// surfaces in the field rather than as silent visual breakage.
			var raMin = Math.min.apply(null, ras);
			var raMax = Math.max.apply(null, ras);
			var wrapped = false;
			if (raMax - raMin > 180) {
				var shifted = ras.map(function (r) { return r < 180 ? r + 360 : r; });
				raMin = Math.min.apply(null, shifted);
				raMax = Math.max.apply(null, shifted);
				wrapped = true;
				var slug = activeVariant.slug || 'unknown';
				if (!warnedUnusableWcsForVariant['_wrap_' + slug]) {
					warnedUnusableWcsForVariant['_wrap_' + slug] = true;
					console.warn('drawGrid: RA wraparound detected on variant "' + slug + '" — applied 360° shift heuristic. Verify grid spacing visually.');
				}
			}

			// Pick spacings. RA range is in raw RA-degrees but one degree of
			// RA subtends only cos(dec) degrees on the sky, so multiply the
			// span by cos(meanDec) before picking spacing — otherwise high-
			// declination fields get sparse RA gridlines (~half density at
			// Dec=+60°). Issue #80.
			var meanDecRad = (decMin + decMax) / 2 * Math.PI / 180;
			var cosMeanDec = Math.cos(meanDecRad);
			// Guard against pathological dec ranges that produce cosMeanDec
			// near 0 (entirely-on-pole field); fall back to raw range.
			var raSkySpan = (raMax - raMin) * (cosMeanDec > 0.05 ? cosMeanDec : 1);
			var raSpacing  = pickGridSpacing(raSkySpan);
			var decSpacing = pickGridSpacing(decMax - decMin);
			var raStart  = Math.floor(raMin  / raSpacing)  * raSpacing;
			var raEnd    = Math.ceil(raMax   / raSpacing)  * raSpacing;
			var decStart = Math.floor(decMin / decSpacing) * decSpacing;
			var decEnd   = Math.ceil(decMax  / decSpacing) * decSpacing;

			// Cap iteration counts to prevent runaway loops if WCS is corrupted
			// (e.g. NaN or extreme values). At a sensible grid this is well under 30.
			var maxLines = 50;

			// Cyan/teal palette matching the annotation circles. Draw with two
			// passes for readability against bright and dark parts of the image:
			//   1. A thin dark halo (rgba(0,0,0,0.55), width 2.2) — gives contrast
			//      against light nebulosity where pure cyan would wash out.
			//   2. The cyan line itself (rgba(100,215,225,0.55), width 1.0) — still
			//      subtle enough not to compete with annotation circles.
			// Two strokes on one path is cheap; the halo pass runs first so the
			// cyan draws over it without double-stroking the edges.
			// 12px sans-serif with a dark backing box reads reliably at any zoom
			// — the previous 11px + 3px stroke halo turned glyphs into blobs
			// because the stroke was wider than the font.
			gridCtx.font         = '12px ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", sans-serif';
			gridCtx.textBaseline = 'top';

			// Sample every grid line ONCE into canvas-pixel polylines. We use the
			// same samples for stroking the grid AND for finding the point where
			// each line crosses the image edge — that guarantees labels sit on
			// the actually-rendered curve, not a re-projected approximation that
			// could drift by tens of pixels on rotated fields.
			var raLines  = [];
			var decLines = [];
			var i = 0;
			for (var ra = raStart; ra <= raEnd && i < maxLines; ra += raSpacing, i++) {
				raLines.push({
					value:  ra,
					points: sampleSkyLine(ra, decStart, ra, decEnd, wcs, contentSize),
				});
			}
			i = 0;
			for (var dec = decStart; dec <= decEnd && i < maxLines; dec += decSpacing, i++) {
				decLines.push({
					value:  dec,
					points: sampleSkyLine(raStart, dec, raEnd, dec, wcs, contentSize),
				});
			}

			// Build a single path containing all RA + Dec polylines, then stroke
			// it twice — first with a dark halo for contrast, then with cyan on top.
			gridCtx.beginPath();
			raLines.forEach(function (l) { strokePolyline(l.points); });
			decLines.forEach(function (l) { strokePolyline(l.points); });
			// Dark halo pass
			gridCtx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
			gridCtx.lineWidth = 2.2;
			gridCtx.stroke();
			// Cyan pass on top
			gridCtx.strokeStyle = 'rgba(100, 215, 225, 0.55)';
			gridCtx.lineWidth = 1.0;
			gridCtx.stroke();

			// ── Labels (AstroBin-style) ──────────────────────────────────────
			// Find where each grid line enters the image along the top (for RA)
			// or left (for Dec) edge, then draw a short tick mark + dark-boxed
			// cyan label at that anchor. Overlap prevention: track every placed
			// anchor on each edge and skip a new label if it would land within
			// `minSep` pixels of any existing one. Tracking ALL (not just the
			// previous) is essential because grid lines aren't always sorted
			// by screen position — RA increases east, but east can be either
			// left-of-center OR right-of-center depending on the field rotation,
			// and similarly Dec direction can flip in flipped-mount images.
			var clip = { x: clipX, y: clipY, w: clipW, h: clipH };
			var placedRaX  = [];
			var placedDecY = [];
			var raMinSep   = 34;
			var decMinSep  = 22;
			raLines.forEach(function (l) {
				var a = findEdgeAnchor(l.points, clip, 'top');
				if (!a) return;
				for (var k = 0; k < placedRaX.length; k++) {
					if (Math.abs(a.x - placedRaX[k]) < raMinSep) return;
				}
				drawLabelAtEdge(formatRaShort(l.value), a.x, a.y, clip, 'top');
				placedRaX.push(a.x);
			});
			decLines.forEach(function (l) {
				var a = findEdgeAnchor(l.points, clip, 'left');
				if (!a) return;
				for (var k = 0; k < placedDecY.length; k++) {
					if (Math.abs(a.y - placedDecY[k]) < decMinSep) return;
				}
				drawLabelAtEdge(formatDecShort(l.value), a.x, a.y, clip, 'left');
				placedDecY.push(a.y);
			});

			gridCtx.restore(); // pop the clip
		}

		/**
		 * showGrid / hideGrid — visibility toggles for the grid canvas.
		 * Coupled to showingObjects state in toggleObjects/flashAnnotations.
		 */
		function showGrid() {
			if (!gridCanvas) return;
			gridCanvas.classList.remove('osd-annotation--hidden');
			gridCanvas.classList.remove('osd-annotation--fade-out');
			drawGrid();
		}
		function hideGrid() {
			if (!gridCanvas) return;
			gridCanvas.classList.add('osd-annotation--hidden');
		}

		/**
		 * destroyGridCanvas — clean teardown for variant switches.
		 * The OSD viewer persists across variant switches, so we only need to
		 * remove DOM/listeners when the lightbox closes (or never — it's cheap
		 * to leave the canvas around). For now we just clear and hide.
		 */
		function clearGrid() {
			if (gridCtx && gridCanvas) {
				var dpr = window.devicePixelRatio || 1;
				gridCtx.clearRect(0, 0, gridCanvas.width / dpr, gridCanvas.height / dpr);
			}
			hideGrid();
		}

		// ── OSD toolbar "Objects" button ────────────────────────────────────

		/**
		 * Creates or updates the "Show Objects" button in the OSD toolbar.
		 * Uses OpenSeadragon.Button — OSD's native image-button class — so
		 * the button has the same 4-state hover/press behavior and visual
		 * style as the built-in zoom-in / zoom-out / home controls.
		 *
		 * The SVG data URIs render a bullseye icon (concentric circles) on
		 * the same rounded-rect backdrop that the native OSD sprites use:
		 * semi-transparent white at rest, orange on hover/press (35×34px).
		 *
		 * The button is appended to viewer.buttons (the existing ButtonGroup)
		 * so it flows inline as a 4th toolbar button. If the ButtonGroup
		 * isn't accessible, falls back to viewer.addControl().
		 *
		 * @param {Object} variant - Variant data with annotations array
		 */
		function setupObjectsButton(variant) {
			var hasAnnotations = variant.annotations && variant.annotations.length > 0;
			// Variants with WCS but zero in-frame Simbad hits still get the
			// button — it controls the RA/Dec gridline overlay too.
			var hasWcs = !!variant.wcs;

			// Remove previous OSD button (element + event listeners)
			if (osdObjectsButton) {
				// Remove from the OSD ButtonGroup's internal list so grouphover
				// state tracking doesn't reference a destroyed button.
				// OSD 6.x renamed viewer.buttons → viewer.buttonGroup.
				var btnGroup = viewer && (viewer.buttonGroup || viewer.buttons);
				if (btnGroup) {
					var idx = btnGroup.buttons.indexOf(osdObjectsButton);
					if (idx >= 0) btnGroup.buttons.splice(idx, 1);
				}
				if (osdObjectsButton.element && osdObjectsButton.element.parentNode) {
					osdObjectsButton.element.parentNode.removeChild(osdObjectsButton.element);
				}
				// destroy() cleans up OSD's internal mouse/touch trackers
				if (typeof osdObjectsButton.destroy === 'function') {
					osdObjectsButton.destroy();
				}
				osdObjectsButton = null;
			}
			objectsBtn = null;

			if ((!hasAnnotations && !hasWcs) || !viewer) return;

			// Create an OSD-native image button using self-hosted PNG sprites.
			// The PNGs are constellation-icon silhouettes composited onto OSD's
			// own blank button sphere templates (button_rest.png etc.), so the
			// look/feel matches the built-in zoom/home buttons pixel-for-pixel.
			//
			// Tooltip describes whichever overlay set this variant has — most
			// have both annotations + grid, but a wcs-only variant gets a
			// grid-focused tooltip so the button's purpose is obvious.
			var tooltip = hasAnnotations
				? 'Show Objects (' + variant.annotations.length + ')'
				: 'Show Sky Grid';
			osdObjectsButton = new OpenSeadragon.Button({
				tooltip: tooltip,
				srcRest:  '/assets/img/objects_rest.png',
				srcGroup: '/assets/img/objects_grouphover.png',
				srcHover: '/assets/img/objects_hover.png',
				srcDown:  '/assets/img/objects_pressed.png',
			});

			// OSD fires 'release' on mouse-up within the button.
			osdObjectsButton.addHandler('release', function () {
				toggleObjects();
			});

			// objectsBtn points to the wrapper element so toggleObjects()
			// can manipulate ARIA attributes and the active-state CSS class.
			objectsBtn = osdObjectsButton.element;
			objectsBtn.setAttribute('aria-label', 'Show identified objects');
			objectsBtn.setAttribute('aria-pressed', 'false');
			// OSD's Button creates a <div>, not a <button>. Add an explicit
			// role so AT announces it correctly and not as a generic group.
			// Issue #86.
			objectsBtn.setAttribute('role', 'button');
			objectsBtn.classList.add('osd-objects-btn');

			// OSD's internal MouseTracker handles pointer events but
			// keyboard activation (Enter / Space) is not consistently wired
			// to the 'release' handler across OSD versions. Belt-and-braces:
			// listen for keydown directly on the button element. Issue #86.
			objectsBtn.addEventListener('keydown', function (e) {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					toggleObjects();
				}
			});

			// Append to OSD's existing ButtonGroup so it sits inline
			// with zoom-in / zoom-out / home as a 4th toolbar button.
			// OSD 6.x renamed viewer.buttons → viewer.buttonGroup.
			var btnGroup = viewer.buttonGroup || viewer.buttons;
			if (btnGroup && btnGroup.element) {
				btnGroup.buttons.push(osdObjectsButton);
				btnGroup.element.appendChild(osdObjectsButton.element);
			} else {
				// Fallback if the ButtonGroup isn't accessible
				viewer.addControl(osdObjectsButton.element, {
					anchor: OpenSeadragon.ControlAnchor.TOP_LEFT
				});
			}
		}

		// ── Coordinate readout + zoom indicator ────────────────────────────

		/**
		 * setupCoordOverlay — wires OSD mouse-move and zoom handlers to
		 * update the coordinate readout overlay at the bottom-left of the
		 * lightbox. Shows RA/Dec of the cursor position (when the variant
		 * has sky data) and zoom percentage (always).
		 *
		 * Pixel → sky conversion uses a simple linear model:
		 *   - Image center (0.5, 0.5) maps to (raDeg, decDeg)
		 *   - FOV width/height in degrees maps to (0…1, 0…1) in image fraction
		 *   - RA offset is divided by cos(dec) for the tangent-plane correction
		 *
		 * This is accurate for small FOVs (<5°) and images aligned to celestial
		 * north. Full WCS (CD matrix) would give rotation-aware transforms but
		 * isn't available yet — see project_dustin_space_wcs_grid.md.
		 *
		 * Called once when the OSD viewer is first created.
		 */
		function setupCoordOverlay() {
			var coordsEl = document.getElementById('osd-coords');
			var raEl     = document.getElementById('osd-coords-ra');
			var decEl    = document.getElementById('osd-coords-dec');
			var zoomEl   = document.getElementById('osd-coords-zoom');
			if (!coordsEl || !viewer) return;

			/**
			 * Converts decimal degrees of RA to a formatted string:
			 * "RAh XXh XXm XX.Xs"
			 * @param {number} raDeg - Right Ascension in decimal degrees (0-360)
			 * @returns {string} Formatted RA string
			 */
			function formatRA(raDeg) {
				// Wrap into 0–360 range (handles negative from subtraction)
				var ra = ((raDeg % 360) + 360) % 360;
				var totalHours = ra / 15;
				var h = Math.floor(totalHours);
				var m = Math.floor((totalHours - h) * 60);
				var s = ((totalHours - h) * 60 - m) * 60;
				return 'RA ' + h + 'h ' + (m < 10 ? '0' : '') + m + 'm ' +
					(s < 10 ? '0' : '') + s.toFixed(1) + 's';
			}

			/**
			 * Converts decimal degrees of Dec to a formatted string:
			 * "Dec ±XX° XX′ XX″"
			 * @param {number} decDeg - Declination in decimal degrees (-90 to +90)
			 * @returns {string} Formatted Dec string
			 */
			function formatDec(decDeg) {
				var sign = decDeg < 0 ? '\u2212' : '+'; // use proper minus sign
				var abs = Math.abs(decDeg);
				var d = Math.floor(abs);
				var m = Math.floor((abs - d) * 60);
				var s = ((abs - d) * 60 - m) * 60;
				return 'Dec ' + sign + d + '\u00b0 ' + (m < 10 ? '0' : '') + m + '\u2032 ' +
					(s < 10 ? '0' : '') + s.toFixed(0) + '\u2033';
			}

			/**
			 * Converts an OSD viewport point to sky coordinates using the
			 * active variant's sky data. Returns null if sky data is missing.
			 *
			 * @param {OpenSeadragon.Point} viewportPoint - point in OSD viewport coords
			 * @returns {{ ra: number, dec: number } | null}
			 */
			function viewportToSky(viewportPoint) {
				if (!activeVariant) return null;

				// Convert viewport coords → image fraction (0–1)
				var imagePoint  = viewer.viewport.viewportToImageCoordinates(viewportPoint);
				var contentSize = viewer.world.getItemAt(0).getContentSize();
				var fx = imagePoint.x / contentSize.x;
				var fy = imagePoint.y / contentSize.y;

				// Prefer full WCS when present — handles rotation correctly and
				// uses the actual plate-solved CD matrix instead of assuming
				// north-up alignment + linear scale. See pixelFracToSky() above.
				if (activeVariant.wcs) {
					return pixelFracToSky(fx, fy, activeVariant.wcs);
				}

				// Fallback: tangent-plane approximation from sky.fovW/H. Accurate
				// for narrow FOVs (<5°) when the image is roughly north-up.
				var sky = activeVariant.sky;
				if (!sky || sky.raDeg == null || sky.decDeg == null || !sky.fovW || !sky.fovH) return null;
				var dx = fx - 0.5;
				var dy = fy - 0.5;
				// RA increases east (image-left in standard orientation), so negate dx.
				// cos(dec) corrects RA foreshortening at the field center.
				var cosDec = Math.cos(sky.decDeg * Math.PI / 180);
				var raDeg  = sky.raDeg - (dx * sky.fovW) / cosDec;
				var decDeg = sky.decDeg - (dy * sky.fovH);
				return { ra: raDeg, dec: decDeg };
			}

			/**
			 * Updates the zoom percentage display. Reads the current zoom from
			 * OSD and converts it to a user-friendly percentage where "fit to
			 * screen" = the zoom level when the full image fits the viewport.
			 */
			function updateZoom() {
				if (!viewer) return;
				// OSD's getZoom(true) returns the "home" zoom at ~1.0 when the
				// image fits the viewport. We normalize to that as 100%.
				var homeZoom = viewer.viewport.getHomeZoom();
				var currentZoom = viewer.viewport.getZoom(true);
				var pct = Math.round((currentZoom / homeZoom) * 100);
				zoomEl.textContent = pct + '%';
			}

			// ── Mouse-move handler: update RA/Dec readout ──────────────────
			// OSD's 'mouse-move' event gives us the position in OSD web coords.
			// We convert to viewport coords, then to sky coords.
			// Uses a tracker on the OSD container element for reliable mouse events.
			var osdContainer = document.getElementById('osd-viewer');
			var tracker = new OpenSeadragon.MouseTracker({
				element: osdContainer,
				// moveHandler fires on every mouse movement over the OSD canvas.
				moveHandler: function (event) {
					if (!activeVariant) return;
					// hasSky: either full WCS (preferred — rotation-aware, plate-solved)
					// or the simpler sky.raDeg/fovW approximation works.
					var hasSky = !!activeVariant.wcs ||
						(activeVariant.sky && activeVariant.sky.raDeg != null);

					// Show the overlay if we have sky data or just zoom
					if (!coordsEl.hidden) {
						// Already visible — just update
					} else if (hasSky) {
						coordsEl.hidden = false;
					}

					if (hasSky) {
						// Convert the DOM pixel position to OSD viewport coordinates
						var webPoint = new OpenSeadragon.Point(event.position.x, event.position.y);
						var viewportPoint = viewer.viewport.pointFromPixel(webPoint);
						var sky = viewportToSky(viewportPoint);
						if (sky) {
							raEl.textContent = formatRA(sky.ra);
							decEl.textContent = formatDec(sky.dec);
						}
					} else {
						raEl.textContent = '';
						decEl.textContent = '';
					}
				},
			});
			tracker.setTracking(true);

			// ── Zoom handler: update percentage ────────────────────────────
			viewer.addHandler('zoom', function () {
				updateZoom();
				// Show the overlay with just zoom % even without sky data
				if (coordsEl.hidden) coordsEl.hidden = false;
			});

			// Initial zoom display once tiles are loaded
			viewer.addOnceHandler('open', function () {
				updateZoom();
			});

			// Hide when mouse leaves the OSD container
			osdContainer.addEventListener('mouseleave', function () {
				// Keep showing zoom only — clear RA/Dec
				raEl.textContent = '';
				decEl.textContent = '';
			});
		}

		/**
		 * Toggles annotation overlay visibility on/off.
		 * Called by the OSD toolbar "Objects" button click handler
		 * and by the flash timeout.
		 */
		function toggleObjects() {
			showingObjects = !showingObjects;
			annotationEls.forEach(function (el) {
				if (showingObjects) {
					el.classList.remove('osd-annotation--hidden');
				} else {
					el.classList.add('osd-annotation--hidden');
				}
			});
			// Grid lines toggle alongside annotations — single button controls
			// both per the design intent (one mental model: "show me what's
			// out there"). Variants without WCS just no-op the grid call.
			if (showingObjects) showGrid(); else hideGrid();
			if (objectsBtn) {
				objectsBtn.setAttribute('aria-pressed', showingObjects ? 'true' : 'false');
				objectsBtn.title = (showingObjects ? 'Hide' : 'Show') + ' Objects';
				objectsBtn.setAttribute('aria-label', (showingObjects ? 'Hide' : 'Show') + ' Objects');
				objectsBtn.classList.toggle('osd-objects-btn--active', showingObjects);
			}
		}

		/**
		 * Briefly shows annotation overlays when the lightbox first opens
		 * for a variant with annotations. Shows for 2 seconds, then fades
		 * out. Only fires once per page session.
		 *
		 * Operates directly on annotation elements without calling
		 * toggleObjects(), so the toolbar button stays in its normal
		 * rest state throughout the flash.
		 *
		 * @param {Object} variant - Variant data with annotations array
		 */
		function flashAnnotations(variant) {
			if (hasFlashedAnnotations) return;
			// Flash if the variant has annotations OR a grid — both share the
			// same toggle, so even a no-annotations / wcs-only variant should
			// reveal its grid briefly to advertise the Objects button's purpose.
			var hasAnyOverlay = (variant.annotations && variant.annotations.length) || variant.wcs;
			if (!hasAnyOverlay) return;

			// WCAG 2.2.2 / 2.3.3: skip the auto-reveal entirely when the user
			// has expressed a reduced-motion preference. The Objects button is
			// still discoverable in the toolbar, and the visually-hidden
			// catalog list (added by addAnnotations) still surfaces the
			// annotations to assistive tech. Issue #86.
			if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
				hasFlashedAnnotations = true;
				return;
			}
			hasFlashedAnnotations = true;

			// Show annotation overlays + grid directly (no button state change)
			annotationEls.forEach(function (el) {
				el.classList.remove('osd-annotation--hidden');
			});
			if (variant.wcs) showGrid();

			// After 2 seconds, fade out and re-hide.
			// Store timer IDs so clearAnnotations can cancel if the user
			// switches variants mid-flash.
			flashTimerA = setTimeout(function () {
				flashTimerA = null;
				// If the user manually toggled objects on during the flash,
				// don't interfere — they own the state now.
				if (showingObjects) return;

				// Add fade-out class for smooth transition (annotations + grid)
				annotationEls.forEach(function (el) {
					el.classList.add('osd-annotation--fade-out');
				});
				if (gridCanvas) gridCanvas.classList.add('osd-annotation--fade-out');
				// After the CSS transition finishes, fully hide
				flashTimerB = setTimeout(function () {
					flashTimerB = null;
					if (!showingObjects) {
						annotationEls.forEach(function (el) {
							el.classList.add('osd-annotation--hidden');
							el.classList.remove('osd-annotation--fade-out');
						});
						if (gridCanvas) {
							gridCanvas.classList.add('osd-annotation--hidden');
							gridCanvas.classList.remove('osd-annotation--fade-out');
						}
					}
				}, 600);
			}, 2000);
		}

		// ── Annotation overlay helpers ───────────────────────────────────────

		/**
		 * Creates OSD overlay elements for the given variant's annotations.
		 * Called after tiles load (via the 'open' handler) so getContentSize()
		 * returns the correct image dimensions.
		 *
		 * @param {Object} variant - Variant data with annotations array
		 */
		/**
		 * buildAccessibleCatalogList — emit a visually-hidden list of every
		 * annotation name (Simbad DSO, ASTAP common name, bright Bayer star)
		 * for the active variant so screen-reader users get the same
		 * identification info as sighted users see in the canvas overlay.
		 * Issue #83.
		 *
		 * Mounted once per addAnnotations call inside #osd-viewer; previous
		 * list (if any) is removed before re-creating so variant switches
		 * don't accumulate stale entries.
		 *
		 * @param {Object} variant
		 */
		function buildAccessibleCatalogList(variant) {
			var osdEl = document.getElementById('osd-viewer');
			if (!osdEl) return;
			// Remove any prior list (variant switch).
			var prior = osdEl.querySelector('.osd-annotation-catalog');
			if (prior) prior.parentNode.removeChild(prior);

			var ul = document.createElement('ul');
			ul.className = 'osd-annotation-catalog visually-hidden';
			ul.setAttribute('aria-label', 'Cataloged objects in this image');

			if (!variant.annotations || !variant.annotations.length) {
				// Empty-state message so AT users hear "no cataloged objects"
				// rather than silence (silent-failure cross-exam).
				var empty = document.createElement('li');
				empty.textContent = 'No cataloged objects in this frame';
				ul.appendChild(empty);
			} else {
				variant.annotations.forEach(function (ann) {
					var li = document.createElement('li');
					var typeHint = ann.source === 'simbad-star' ? 'star' :
					               (ann.type ? '(' + ann.type + ')' : 'object');
					// Format: "<catalog name> — <common name> — <typeHint>" when
					// a colloquial name exists (e.g. "NGC 6960 — Veil Nebula
					// West — (ISM)"). Falls back to "<catalog name> — <typeHint>"
					// when there's no common_name. textContent is the safe
					// sink — name + common_name come from external catalog
					// data and must never reach the HTML setter.
					var label = ann.common_name && ann.common_name !== ann.name
						? ann.name + ' — ' + ann.common_name + ' — ' + typeHint
						: ann.name + ' — ' + typeHint;
					li.textContent = label;
					ul.appendChild(li);
				});
			}
			osdEl.appendChild(ul);
		}

		function addAnnotations(variant) {
			// Set up the gridline canvas + initial draw if this variant has WCS.
			// Idempotent — setupGridCanvas only creates the canvas once per OSD
			// viewer; subsequent calls no-op. drawGrid uses activeVariant.wcs,
			// which the caller (openLightbox) sets before invoking us.
			if (variant.wcs) {
				setupGridCanvas();
				drawGrid();
			}

			// ── Visually-hidden catalog list for assistive tech (issue #83) ──
			// Annotations on the canvas are aria-hidden=true (decorative
			// positional artifacts). Build a parallel screen-reader-only list
			// of object names so AT users get the same identification info as
			// sighted users. Same data array, single source of truth — drift
			// between the two is impossible.
			//
			// SECURITY: textContent only (per Phase B sec/silent cross-exam).
			// Catalog names from Simbad/ASTAP are external data; using
			// the HTML setter would open an XSS path that doesn't exist today.
			buildAccessibleCatalogList(variant);

			if (!variant.annotations || !variant.annotations.length) return;
			if (!viewer || !viewer.world.getItemAt(0)) return;

			// getContentSize() returns the pixel dimensions of the loaded image.
			// Used to convert fractional positions (0-1) to image-pixel coordinates.
			var imgSize = viewer.world.getItemAt(0).getContentSize();

			// Format the visible label as "<catalog name> — <common name>"
			// when both are present (e.g. "NGC 6960 — Veil Nebula West"),
			// otherwise fall back to just the catalog name. Skips the join
			// when common_name happens to equal name (Pickering's Triangle
			// has only the one alias).
			function formatLabel(ann) {
				return ann.common_name && ann.common_name !== ann.name
					? ann.name + ' — ' + ann.common_name
					: ann.name;
			}

			variant.annotations.forEach(function (ann) {
				if (ann.radius != null && ann.radius > 0) {
					// ── Circle annotation ──────────────────────────────────────
					// ann.radius is a fraction of image WIDTH.
					// Convert to pixels, build a square bounding box (OSD + border-radius:50% = circle).
					var el = document.createElement('div');
					el.className = 'osd-annotation osd-annotation--hidden osd-annotation-circle';
					el.setAttribute('data-annotation-type', 'circle');
					// Source tag lets CSS/future code differentiate DSO circles
					// from stars (once stars ever grow to have radius — none do today).
					el.setAttribute('data-annotation-source', ann.source || 'simbad');
					el.setAttribute('aria-hidden', 'true');

					var labelEl = document.createElement('span');
					labelEl.className = 'osd-annotation-label';
					labelEl.textContent = formatLabel(ann);
					el.appendChild(labelEl);

					// Convert the width-fraction radius to pixels.
					// Both the circle's width and height in pixels are the same (it's a circle).
					var rx_px = ann.radius * imgSize.x;

					// imageToViewportRectangle(x, y, w, h) takes image-pixel coordinates
					// and returns a viewport Rect. By passing equal width and height in pixels,
					// the resulting Rect is a visual square — border-radius:50% makes it a circle.
					// No manual aspect correction needed.
					var rect = viewer.viewport.imageToViewportRectangle(
						ann.x * imgSize.x - rx_px,    // left edge in pixels
						ann.y * imgSize.y - rx_px,    // top edge in pixels
						rx_px * 2,                     // width in pixels
						rx_px * 2                      // height in pixels (same = circle)
					);
					viewer.addOverlay({ element: el, location: rect });

				} else {
					// ── Point annotation ───────────────────────────────────────
					// Zero-size div + 7px dot + label. Used for both unsized
					// DSOs and bright Bayer stars (source='simbad-star'); the
					// source attribute lets CSS style the star dots distinctly
					// from generic DSO points (e.g. smaller, diamond marker,
					// gold tint) without touching the JS structure.
					var el = document.createElement('div');
					el.className = 'osd-annotation osd-annotation--hidden';
					el.setAttribute('data-annotation-type', 'point');
					el.setAttribute('data-annotation-source', ann.source || 'simbad');
					el.setAttribute('aria-hidden', 'true');

					var dot = document.createElement('span');
					dot.className = 'osd-annotation-dot';
					var labelEl = document.createElement('span');
					labelEl.className = 'osd-annotation-label';
					labelEl.textContent = formatLabel(ann);
					el.appendChild(dot);
					el.appendChild(labelEl);

					// Convert 0-1 fraction -> image pixels -> OSD viewport coordinates.
					var vpPt = viewer.viewport.imageToViewportCoordinates(
						ann.x * imgSize.x,
						ann.y * imgSize.y
					);
					viewer.addOverlay({ element: el, location: vpPt });
				}

				annotationEls.push(el);
			});
		}

		/**
		 * Removes all annotation overlays from the viewer.
		 * Called before switching to a different variant's tiles.
		 */
		function clearAnnotations() {
			// Cancel any pending flash timers so they don't fire against
			// the next variant's annotation elements after a switch.
			if (flashTimerA) { clearTimeout(flashTimerA); flashTimerA = null; }
			if (flashTimerB) { clearTimeout(flashTimerB); flashTimerB = null; }

			annotationEls.forEach(function (el) {
				if (viewer) viewer.removeOverlay(el);
				if (el.parentNode) el.parentNode.removeChild(el);
			});
			annotationEls = [];
			showingObjects = false;
			// Clear + hide the grid canvas (matches the toggle state reset).
			// The canvas itself stays in the DOM and gets re-used + redrawn
			// when addAnnotations runs against the next variant.
			clearGrid();
			// Remove the visually-hidden catalog list (issue #83) so a variant
			// switch doesn't leave the previous variant's names announced to AT.
			var osdEl = document.getElementById('osd-viewer');
			var prior = osdEl && osdEl.querySelector('.osd-annotation-catalog');
			if (prior) prior.parentNode.removeChild(prior);
		}

		// ── Revision filmstrip helpers ───────────────────────────────────────

		/**
		 * Renders revision buttons in the filmstrip strip below the OSD viewer.
		 *
		 * Each button shows the revision's label (e.g. "v2 — PixInsight reprocess").
		 * The active revision gets the .active class (accent border via CSS).
		 * Clicking a button swaps the OSD tile source to that revision's DZI,
		 * updates the note text, and calls history.replaceState to update the URL.
		 *
		 * When the variant has 0 or 1 revisions, the filmstrip stays hidden —
		 * there's nothing to switch between.
		 *
		 * @param {Object} variant  - The active variant object
		 * @param {Object|null} currentRevision - The initially active revision
		 */
		function renderFilmstrip(variant, currentRevision) {
			if (!revisionStrip || !revisionNote) return;

			// Clear any previous filmstrip content from a prior lightbox open
			clearFilmstrip();

			var revisions = variant.revisions || [];

			// Only show the filmstrip when there are 2+ revisions to choose from.
			// A single revision means there's only one processing version — no toggle needed.
			if (revisions.length < 2) return;

			// Build one button per revision
			revisions.forEach(function (rev) {
				var btn = document.createElement('button');
				btn.className = 'revision-btn';
				btn.textContent = rev.label;

				// Mark the initially active revision
				if (currentRevision && rev.id === currentRevision.id) {
					btn.classList.add('active');
				}

				// Click handler — swap the OSD tile source to this revision's DZI
				btn.addEventListener('click', function () {
					switchRevision(variant, rev);
				});

				revisionStrip.appendChild(btn);
			});

			// Show the filmstrip and the processing note for the active revision
			revisionStrip.hidden = false;
			if (currentRevision && currentRevision.note) {
				revisionNote.textContent = currentRevision.note;
				revisionNote.hidden = false;
			}
		}

		/**
		 * Switches the lightbox to display a different revision's tiles.
		 *
		 * Called when the user clicks a filmstrip button. This:
		 *   1. Opens the new revision's DZI in OSD (seamless tile swap)
		 *   2. Updates the active button styling in the filmstrip
		 *   3. Updates the note text below the filmstrip
		 *   4. Resets the annotation toggle (annotated DZI may differ per revision)
		 *   5. Updates the URL via history.replaceState
		 *
		 * @param {Object} variant  - The parent variant (for fallback URLs and annotations)
		 * @param {Object} revision - The revision to switch to
		 */
		function switchRevision(variant, revision) {
			if (!viewer || !revision) return;

			activeRevision = revision;

			// Swap tile source — OSD handles this seamlessly, loading new tiles
			// into the existing viewport without destroying the viewer instance.
			var newDzi = revision.dzi_url || variant.dziUrl;
			clearAnnotations();
			viewer.open(newDzi);

			// Re-add annotations once the new tiles are loaded.
			// Annotations are variant-level (same across all revisions of
			// the same raw data), so we use the variant's annotation array.
			viewer.addOnceHandler('open', function () {
				addAnnotations(variant);
			});

			// Reset annotation toggle state since the annotated DZI may
			// differ between revisions
			showingAnnotated = false;
			if (annotBtn) {
				var newAnnotDzi = revision.annotated_dzi_url || variant.annotatedDziUrl;
				annotBtn.hidden = !newAnnotDzi;
				annotBtn.textContent = 'Show Annotations';
				annotBtn.setAttribute('aria-pressed', 'false');
			}

			// Update filmstrip active state — remove .active from all buttons,
			// add it to the one matching this revision
			var buttons = revisionStrip.querySelectorAll('.revision-btn');
			var revisions = variant.revisions || [];
			for (var i = 0; i < buttons.length; i++) {
				// Buttons are rendered in the same order as revisions array,
				// so index correspondence tells us which button matches which revision
				if (revisions[i] && revisions[i].id === revision.id) {
					buttons[i].classList.add('active');
				} else {
					buttons[i].classList.remove('active');
				}
			}

			// Update the note text below the filmstrip
			if (revisionNote) {
				if (revision.note) {
					revisionNote.textContent = revision.note;
					revisionNote.hidden = false;
				} else {
					revisionNote.textContent = '';
					revisionNote.hidden = true;
				}
			}

			// Update URL to reflect the new revision
			updateUrlState(variant.id, revision);
		}

		/**
		 * Clears the filmstrip — removes all buttons and hides the containers.
		 * Called when closing the lightbox and before rendering a new filmstrip.
		 */
		function clearFilmstrip() {
			if (revisionStrip) {
				revisionStrip.textContent = '';
				revisionStrip.hidden = true;
			}
			if (revisionNote) {
				revisionNote.textContent = '';
				revisionNote.hidden = true;
			}
		}

		/**
		 * Updates the URL query parameter to reflect the current lightbox state.
		 *
		 * Format: ?r=variantId:revisionId (e.g. ?r=narrowfield:v2)
		 * When no revision is active: ?r=variantId (e.g. ?r=default)
		 *
		 * Uses history.replaceState (not pushState) so switching revisions
		 * doesn't pollute the browser back-button history — the filmstrip
		 * is a view-state toggle, not a navigation event.
		 *
		 * @param {string} variantId - The active variant's ID
		 * @param {Object|null} revision - The active revision, or null
		 */
		function updateUrlState(variantId, revision) {
			if (!window.history || !history.replaceState) return;

			var url = new URL(window.location);
			var rValue = variantId;
			if (revision) {
				rValue += ':' + revision.id;
			}
			url.searchParams.set('r', rValue);
			history.replaceState(null, '', url.pathname + '?' + url.searchParams.toString() + url.hash);
		}

		// ── Close lightbox ───────────────────────────────────────────────────
		function closeLightbox() {
			lightbox.hidden = true;
			document.body.style.overflow = '';

			// Clear the revision filmstrip so it doesn't show stale buttons
			// the next time the lightbox opens for a different variant
			clearFilmstrip();

			// Remove the ?r= query parameter from the URL so a page reload
			// doesn't re-open the lightbox unexpectedly
			if (window.history && history.replaceState) {
				var url = new URL(window.location);
				url.searchParams.delete('r');
				// Build clean URL: pathname + remaining params (if any) + hash
				var cleanUrl = url.pathname;
				var remaining = url.searchParams.toString();
				if (remaining) cleanUrl += '?' + remaining;
				if (url.hash) cleanUrl += url.hash;
				history.replaceState(null, '', cleanUrl);
			}

			// Return focus to the trigger that opened the lightbox
			// so keyboard users aren't stranded
			if (lastTrigger) lastTrigger.focus();
			lastTrigger    = null;
			activeVariant  = null;
			activeRevision = null;
		}

		// ── bfcache restore cleanup ──────────────────────────────────────────
		// When the user navigates away with the lightbox open and hits the back
		// button, the browser restores the page from bfcache — with body scroll
		// still locked. The pageshow event fires on bfcache restore (persisted=true)
		// and lets us clean up the leftover state.
		window.addEventListener('pageshow', function (e) {
			if (e.persisted && !lightbox.hidden) {
				closeLightbox();
			}
		});

		// ── Event wiring ─────────────────────────────────────────────────────
		// Wire up all zoom triggers — each has a data-variant attribute that
		// tells us which variant's DZI to load. querySelectorAll returns all
		// .zoom-trigger buttons on the page (one for single-variant, one per
		// variant section for multi-variant).
		Array.prototype.forEach.call(triggers, function (trigger) {
			trigger.addEventListener('click', function () {
				var variantId = this.getAttribute('data-variant');
				openLightbox(variantId, this);
			});
		});
		if (closeBtn) closeBtn.addEventListener('click', closeLightbox);

		// ── Keyboard navigation + focus trap ─────────────────────────────────
		// Handled at the document level so the user doesn't need to click into
		// the viewer first — any key press while the lightbox is open works.
		//
		// Tab / Shift+Tab: focus trap — cycle only through lightbox controls
		// Arrow keys: pan the viewport by 10% per press
		// + / = : zoom in  |  - / _ : zoom out
		// Escape: close lightbox
		document.addEventListener('keydown', function (e) {
			if (lightbox.hidden) return;

			// ── Focus trap ─────────────────────────────────────────────────────
			if (e.key === 'Tab') {
				var focusable = Array.prototype.slice.call(
					lightbox.querySelectorAll(
						':is(button, [role="button"], a[href], [tabindex="0"]):not([disabled], [tabindex="-1"])'
					)
				);
				if (focusable.length === 0) { e.preventDefault(); return; }
				var first = focusable[0];
				var last  = focusable[focusable.length - 1];
				if (e.shiftKey) {
					if (document.activeElement === first) { e.preventDefault(); last.focus(); }
				} else {
					if (document.activeElement === last) { e.preventDefault(); first.focus(); }
				}
				return;
			}

			if (e.key === 'Escape') { closeLightbox(); return; }

			// Remaining shortcuts require the viewer to be initialised
			if (!viewer) return;

			var vp      = viewer.viewport;
			var panStep = 0.1; // fraction of viewport per keypress

			switch (e.key) {
				case 'ArrowLeft':
					e.preventDefault();
					vp.panBy(new OpenSeadragon.Point(-panStep, 0));
					break;
				case 'ArrowRight':
					e.preventDefault();
					vp.panBy(new OpenSeadragon.Point(panStep, 0));
					break;
				case 'ArrowUp':
					e.preventDefault();
					vp.panBy(new OpenSeadragon.Point(0, -panStep));
					break;
				case 'ArrowDown':
					e.preventDefault();
					vp.panBy(new OpenSeadragon.Point(0, panStep));
					break;
				case '+':
				case '=':
					vp.zoomBy(1.4);
					vp.applyConstraints();
					break;
				case '-':
				case '_':
					vp.zoomBy(1 / 1.4);
					vp.applyConstraints();
					break;
			}
		});

		// ── Auto-open from URL state ─────────────────────────────────────────
		// If the URL contains ?r=variantId or ?r=variantId:revisionId, auto-open
		// the lightbox at that state. This supports shareable deep links into
		// specific revision views.
		//
		// Format: ?r=narrowfield:v2  → open narrowfield variant at revision v2
		//         ?r=default         → open default variant at its final revision
		//
		// The trigger element is found by matching [data-variant="variantId"]
		// so focus return on close still works correctly.
		(function autoOpenFromUrl() {
			var params = new URLSearchParams(window.location.search);
			var rParam = params.get('r');
			if (!rParam) return;

			// Split on the first colon: "narrowfield:v2" → ["narrowfield", "v2"]
			// A bare "default" (no colon) means open that variant at its final revision.
			var colonIdx  = rParam.indexOf(':');
			var variantId = colonIdx === -1 ? rParam : rParam.substring(0, colonIdx);
			var revId     = colonIdx === -1 ? null   : rParam.substring(colonIdx + 1);

			// Validate: the variant must exist in our data
			if (!variantMap[variantId]) return;

			// Find the matching zoom trigger so focus can return to it on close.
			// querySelectorAll returns all .zoom-trigger buttons; we want the one
			// whose data-variant matches our variant ID.
			var matchingTrigger = null;
			Array.prototype.forEach.call(triggers, function (t) {
				if (t.getAttribute('data-variant') === variantId) {
					matchingTrigger = t;
				}
			});

			openLightbox(variantId, matchingTrigger, revId || undefined);
		})();
	}


	// ═══════════════════════════════════════════════════════════════════════════
	//  ALADIN LITE — Sky atlas widget
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * initAladin — lazy-loads Aladin Lite via IntersectionObserver for one variant.
	 *
	 * Called once per variant that has sky data. Each variant's sky object includes
	 * a containerId pointing to its unique <div> in the template (e.g.
	 * "aladin-default", "aladin-narrowfield"). Multi-variant pages can have
	 * multiple sky atlases at different coordinates.
	 *
	 * Receives the variant's sky object. Expects:
	 *   sky.containerId  — DOM id of the Aladin container div
	 *   sky.aladinTarget — Simbad-resolvable name (e.g. "M42")
	 *   sky.fovDeg       — field of view in degrees
	 *   sky.raDeg        — RA in decimal degrees (for FoV rectangle)
	 *   sky.decDeg       — Dec in decimal degrees
	 *   sky.fovW         — camera FoV width in degrees
	 *   sky.fovH         — camera FoV height in degrees
	 *
	 * The Aladin Lite library (~1MB) is loaded via dynamic import() only
	 * when the widget scrolls near the viewport (300px margin).
	 *
	 * @param {Object} sky - The variant's sky data object from the JSON bridge
	 */
	function initAladin(sky) {
		var el = document.getElementById(sky.containerId);
		if (!el || !sky.aladinTarget) return;

		// IntersectionObserver defers initialisation until the widget is
		// near the viewport — saves ~1MB of JS on pages where the user
		// never scrolls down to the sky atlas section.
		var observer = new IntersectionObserver(function (entries, obs) {
			if (!entries[0].isIntersecting) return;
			obs.disconnect();

			(async function () {
				try {
					// Dynamic import() loads Aladin Lite from a self-hosted copy.
					// Self-hosted (not CDN) so we can serve the WASM binary as a
					// separate .wasm file with correct MIME type — avoids needing
					// 'unsafe-eval' in the CSP for Firefox's sync WASM fallback.
					// Version: 3.8.2 — update both aladin.js and aladin.wasm together.
					var mod = await import('/assets/js/aladin.js');
					var A = mod.default;

					// A.init is a Promise that resolves once the WASM module
					// has been fetched and instantiated. Must await it before
					// calling A.aladin() — the widget constructor accesses
					// WASM exports (WebClient) that aren't available until init
					// completes. Without this, the 1.4MB network fetch for the
					// .wasm file creates a race that the constructor always loses.
					await A.init;

					// Mark the container as an interactive application region so
					// screen readers announce it as a sky atlas rather than
					// treating it as generic content.
					el.setAttribute('role', 'application');
					el.setAttribute('aria-label', 'Interactive sky atlas — ' + sky.aladinTarget);

					// Initialise the Aladin Lite widget. A.aladin() is synchronous
					// (returns the instance directly, not a Promise).
					var aladin = A.aladin('#' + sky.containerId, {
						survey: 'P/DSS2/color',
						fov: sky.fovDeg || 1.5,
						target: sky.aladinTarget,
						showReticle: false,
						showZoomControl: true,
						showFullscreenControl: false,
						showLayersControl: false,
						showGotoControl: false,
					});

					// ── FoV rectangle overlay ───────────────────────────────────
					// Drawn when all four coordinates are present. Shows the camera's
					// actual field of view as a cyan rectangle on the sky atlas.
					// RA offset is divided by cos(dec) so the box stays rectangular
					// at high declinations.
					if (sky.fovW && sky.fovH && sky.raDeg != null && sky.decDeg != null) {
						var hw     = sky.fovW / 2;
						var hh     = sky.fovH / 2;
						var cosDec = Math.cos(sky.decDeg * Math.PI / 180);
						var dRa    = hw / cosDec;

						var corners = [
							[sky.raDeg + dRa, sky.decDeg + hh],
							[sky.raDeg - dRa, sky.decDeg + hh],
							[sky.raDeg - dRa, sky.decDeg - hh],
							[sky.raDeg + dRa, sky.decDeg - hh],
						];

						var overlay = A.graphicOverlay({
							color:     'rgba(100, 210, 220, 0.7)',
							lineWidth: 1.5,
						});
						aladin.addOverlay(overlay);
						overlay.add(A.polygon(corners));
					}

				} catch (e) {
					// If import() / A.init / WASM instantiation / overlay
					// construction fails, log the actual error so DevTools
					// surfaces what broke, then show a user-facing fallback
					// instead of a blank widget. Without the console.error,
					// every failure mode looked identical (CDN outage, MIME
					// mismatch, API drift after upgrade, ReferenceError in
					// the try-body) — impossible to triage in the field.
					// Issue #85.
					console.error('Aladin init failed:', e);
					var msg = document.createElement('div');
					msg.className = 'aladin-na';
					msg.setAttribute('role', 'status');     // a11y: AT announces on inject
					msg.setAttribute('aria-live', 'polite');
					msg.textContent = 'Sky atlas unavailable.';
					el.textContent = '';
					el.appendChild(msg);
				}
			})();
		}, { rootMargin: '300px' });

		observer.observe(el);
	}


	// ═══════════════════════════════════════════════════════════════════════════
	//  COMPARISON SLIDER — before/after revision comparison
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * initComparisonSliders — builds interactive before/after comparison sliders.
	 *
	 * Finds all .comparison-slider containers on the page and creates the
	 * interactive DOM inside each one:
	 *   - Two stacked images: "after" (full, behind) and "before" (clipped, on top)
	 *   - A vertical handle that the user drags left/right to reveal more of one side
	 *   - Labels identifying the before/after versions
	 *
	 * The "before" image uses CSS `clip-path: inset()` to clip its right edge at the
	 * handle position. This keeps both images pixel-aligned — critical for revision
	 * comparison where processing differences are subtle.
	 *
	 * Supports mouse drag, touch drag, and keyboard (arrow keys) input.
	 * The handle is a focusable element with ARIA slider role for screen readers.
	 */
	function initComparisonSliders() {
		// querySelectorAll returns a NodeList — convert to array for .forEach
		var sliders = document.querySelectorAll('.comparison-slider');
		if (!sliders.length) return;

		// activeSlider: tracks which slider (if any) is being dragged.
		// Set by mousedown/touchstart on a handle, cleared by mouseup/touchend.
		// The shared document-level listeners (below the loop) check this reference
		// instead of each slider registering its own document listeners.
		var activeSlider = null;

		sliders.forEach(function (container) {
			// Read the image URLs and labels from data attributes set by Nunjucks
			var beforeSrc   = container.dataset.before;
			var afterSrc    = container.dataset.after;
			var beforeLabel = container.dataset.beforeLabel;
			var afterLabel  = container.dataset.afterLabel;

			// Both images must exist for the slider to work
			if (!beforeSrc || !afterSrc) return;

			// ── Build the DOM structure ──────────────────────────────────────
			// wrapper: position:relative container holding both images and the handle
			var wrapper = document.createElement('div');
			wrapper.className = 'cs-wrapper';

			// "After" image — sits behind, fully visible. This is the newer revision.
			// loading="lazy" prevents these ~2400px WebPs from loading until the
			// slider is near the viewport (it's usually below the fold).
			var afterImg = document.createElement('img');
			afterImg.src = afterSrc;
			afterImg.alt = afterLabel;
			afterImg.className = 'cs-img cs-img--after';
			afterImg.loading = 'lazy';

			// "Before" image — sits on top, clipped from the right by clip-path.
			// At 50% position, the left half shows "before", right half shows "after".
			var beforeImg = document.createElement('img');
			beforeImg.src = beforeSrc;
			beforeImg.alt = beforeLabel;
			beforeImg.loading = 'lazy';
			beforeImg.className = 'cs-img cs-img--before';

			// Handle — the draggable vertical line with a circular grip.
			// role="slider" + aria attributes let screen readers announce it.
			// tabIndex=0 makes it focusable for keyboard navigation.
			var handle = document.createElement('div');
			handle.className = 'cs-handle';
			handle.setAttribute('role', 'slider');
			handle.setAttribute('aria-label', 'Comparison slider');
			handle.setAttribute('aria-valuemin', '0');
			handle.setAttribute('aria-valuemax', '100');
			handle.setAttribute('aria-valuenow', '50');
			handle.tabIndex = 0;

			// Left/right arrows inside the handle grip for visual affordance
			var grip = document.createElement('span');
			grip.className = 'cs-grip';
			grip.setAttribute('aria-hidden', 'true');
			grip.textContent = '◄ ►';
			handle.appendChild(grip);

			wrapper.appendChild(afterImg);
			wrapper.appendChild(beforeImg);
			wrapper.appendChild(handle);

			// ── Labels — "v1 — First light" / "v2 — PixInsight reprocess" ────
			var lBefore = document.createElement('span');
			lBefore.className = 'cs-label cs-label--before';
			lBefore.textContent = beforeLabel;
			var lAfter = document.createElement('span');
			lAfter.className = 'cs-label cs-label--after';
			lAfter.textContent = afterLabel;
			wrapper.appendChild(lBefore);
			wrapper.appendChild(lAfter);

			// Replace the <noscript> content with the interactive slider
			container.textContent = '';
			container.appendChild(wrapper);

			// ── Slider interaction ───────────────────────────────────────────
			// position: percentage from left (0 = all "after", 100 = all "before")
			var position = 50;

			/**
			 * Set the slider position.
			 * Clamps to 0–100, updates the clip-path on the before image,
			 * moves the handle, and updates the ARIA value.
			 *
			 * @param {number} pct - Percentage from the left edge (0–100)
			 */
			function setPosition(pct) {
				pct = Math.max(0, Math.min(100, pct));
				position = pct;
				// clip-path: inset(top right bottom left)
				// We clip from the right edge by (100 - pct)% to reveal that much "after"
				beforeImg.style.clipPath = 'inset(0 ' + (100 - pct) + '% 0 0)';
				handle.style.left = pct + '%';
				handle.setAttribute('aria-valuenow', Math.round(pct));
			}

			// Start at 50% — half "before", half "after"
			setPosition(50);

			// slider: object that the shared document-level listeners use to
			// call back into this closure. onMove converts a clientX pixel
			// position to a 0–100 percentage relative to this slider's wrapper,
			// then calls setPosition. This avoids each slider registering its
			// own document-level mousemove/touchmove listeners (4N → 4 total).
			var slider = {
				onMove: function (clientX) {
					var rect = wrapper.getBoundingClientRect();
					setPosition(((clientX - rect.left) / rect.width) * 100);
				}
			};

			// ── Mouse drag ──────────────────────────────────────────────────
			// mousedown on the handle sets this slider as the active one.
			// Document-level move/up listeners are shared across all sliders
			// (registered once outside the loop — see below).
			handle.addEventListener('mousedown', function (e) {
				activeSlider = slider;
				e.preventDefault(); // prevent text selection while dragging
			});

			// ── Touch drag ──────────────────────────────────────────────────
			// passive: false allows e.preventDefault() to stop page scrolling
			// while dragging the handle on touch devices
			handle.addEventListener('touchstart', function (e) {
				activeSlider = slider;
				e.preventDefault();
			}, { passive: false });

			// ── Keyboard ────────────────────────────────────────────────────
			// Arrow keys move the slider by 2% per press for fine control
			handle.addEventListener('keydown', function (e) {
				if (e.key === 'ArrowLeft') {
					setPosition(position - 2);
					e.preventDefault();
				}
				if (e.key === 'ArrowRight') {
					setPosition(position + 2);
					e.preventDefault();
				}
			});
		});

		// ── Shared document-level listeners ─────────────────────────────
		// Registered once regardless of slider count. Each listener checks
		// the activeSlider reference (set by mousedown/touchstart above).
		// This avoids accumulating 4N listeners for N sliders.

		// mousemove on document (not wrapper) so dragging continues even if
		// the cursor moves outside the slider during a fast swipe
		document.addEventListener('mousemove', function (e) {
			if (!activeSlider) return;
			activeSlider.onMove(e.clientX);
		});

		document.addEventListener('mouseup', function () {
			activeSlider = null;
		});

		// passive: false on touchmove allows e.preventDefault() to stop
		// page scrolling while the user drags the slider handle horizontally
		document.addEventListener('touchmove', function (e) {
			if (!activeSlider) return;
			e.preventDefault();
			activeSlider.onMove(e.touches[0].clientX);
		}, { passive: false });

		document.addEventListener('touchend', function () {
			activeSlider = null;
		});
	}

}());
