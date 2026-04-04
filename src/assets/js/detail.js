/**
 * detail.js — Image detail page behaviour
 *
 * Handles three independent concerns for gallery detail pages:
 *   1. OpenSeadragon (OSD) lightbox — deep zoom viewer with annotations
 *   2. Keyboard navigation — arrow keys, zoom, escape inside the lightbox
 *   3. Aladin Lite sky atlas — lazy-loaded via IntersectionObserver
 *
 * Template data is passed via a <script id="image-data" type="application/json">
 * block in image.njk. This file reads that JSON on DOMContentLoaded and passes
 * the parsed object to each init function. This keeps Nunjucks template syntax
 * entirely out of the JavaScript file — the JSON block is the only bridge.
 *
 * Phase 3: the JSON bridge now contains a `variants` array. Each variant has
 * its own DZI URL, annotations, and sky coordinates. The lightbox is shared
 * across all variants — the zoom trigger's `data-variant` attribute tells
 * detail.js which variant's tiles to load.
 *
 * Loaded with `defer` so it runs after the DOM is parsed but before DOMContentLoaded.
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
		// If the JSON is malformed, bail silently — the page still renders,
		// just without lightbox/aladin interactivity.
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
		var objectsBtn = document.getElementById('objects-toggle');

		// All zoom triggers on the page — one per variant (or one at page hero for single-variant)
		var triggers = document.querySelectorAll('.zoom-trigger');

		if (!lightbox || !triggers.length) return;

		// OSD instance — created once on first open, reused on subsequent opens
		var viewer = null;

		// The variant whose tiles are currently loaded in the lightbox.
		// Updated every time the lightbox opens for a (possibly different) variant.
		var activeVariant = null;

		// The zoom trigger button that opened the lightbox. Used to return
		// focus on close so keyboard users aren't stranded.
		var lastTrigger = null;

		// Annotation overlay elements for the current variant — div elements
		// positioned by OSD at the annotation's image coordinates.
		var annotationEls    = [];
		var showingObjects   = false;
		var showingAnnotated = false;

		// Flag to ensure annotBtn/objectsBtn listeners are registered only once.
		// Without this guard, an open-failed → viewer=null → reopen cycle re-runs
		// the if(!viewer) block and adds duplicate handlers on every reopen.
		var listenersRegistered = false;

		// ── Open lightbox ────────────────────────────────────────────────────

		/**
		 * Opens the lightbox for the specified variant.
		 *
		 * @param {string} variantId - The variant ID (from data-variant attribute)
		 * @param {HTMLElement} triggerEl - The button that was clicked (for focus return)
		 */
		function openLightbox(variantId, triggerEl) {
			var variant = variantMap[variantId];
			if (!variant || !variant.dziUrl) return;

			activeVariant = variant;
			lastTrigger   = triggerEl;
			lightbox.hidden = false;

			// Lock page scroll so the user can't accidentally scroll
			// the page while panning inside the lightbox
			document.body.style.overflow = 'hidden';

			// Show/hide annotation buttons based on this variant's data.
			// Different variants may have different annotated DZIs and object labels.
			if (annotBtn) {
				annotBtn.hidden = !variant.annotatedDziUrl;
			}
			if (objectsBtn) {
				objectsBtn.hidden = !variant.annotations || variant.annotations.length === 0;
			}

			// Reset annotation toggle state for the new variant
			showingAnnotated = false;
			showingObjects   = false;
			if (annotBtn) {
				annotBtn.textContent = 'Show Annotations';
				annotBtn.setAttribute('aria-pressed', 'false');
			}
			if (objectsBtn) {
				objectsBtn.textContent = 'Show Objects';
				objectsBtn.setAttribute('aria-pressed', 'false');
			}

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
					tileSources: variant.dziUrl,

					// Minimap
					showNavigator:       true,
					navigatorPosition:   'BOTTOM_RIGHT',
					navigatorSizeRatio:  0.12,
					navigatorAutoResize: false,

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
					if (objectsBtn) {
						objectsBtn.textContent = 'Show Objects';
						objectsBtn.setAttribute('aria-pressed', 'false');
					}
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
				});

			} else {
				// ── Subsequent open: switch tile source if variant changed ────
				// Clear previous variant's annotations, then load new tiles.
				// addAnnotations() runs after the new source is ready.
				clearAnnotations();
				viewer.open(variant.dziUrl);
				viewer.addOnceHandler('open', function () {
					addAnnotations(variant);
				});
			}

			// ── Register click handlers once ─────────────────────────────────
			// Kept outside the if(!viewer) block so an open-failed → viewer=null →
			// reopen cycle does not add duplicate listeners on each reopen.
			if (!listenersRegistered) {
				listenersRegistered = true;

				// Tile-source annotation toggle — swaps between the clean and
				// annotated DZI tile sets for the currently active variant.
				if (annotBtn) {
					annotBtn.addEventListener('click', function () {
						if (!viewer || !activeVariant) return;
						showingAnnotated = !showingAnnotated;
						viewer.open(showingAnnotated ? activeVariant.annotatedDziUrl : activeVariant.dziUrl);
						annotBtn.textContent = showingAnnotated ? 'Hide Annotations' : 'Show Annotations';
						annotBtn.setAttribute('aria-pressed', showingAnnotated ? 'true' : 'false');
					});
				}

				// Toggle all annotation overlay labels on/off
				if (objectsBtn) {
					objectsBtn.addEventListener('click', function () {
						showingObjects = !showingObjects;
						annotationEls.forEach(function (el) {
							el.style.display = showingObjects ? 'block' : 'none';
						});
						objectsBtn.textContent = showingObjects ? 'Hide Objects' : 'Show Objects';
						objectsBtn.setAttribute('aria-pressed', showingObjects ? 'true' : 'false');
					});
				}
			}

			// Return focus to close button for keyboard accessibility
			if (closeBtn) closeBtn.focus();
		}

		// ── Annotation overlay helpers ───────────────────────────────────────

		/**
		 * Creates OSD overlay elements for the given variant's annotations.
		 * Called after tiles load (via the 'open' handler) so getContentSize()
		 * returns the correct image dimensions.
		 *
		 * @param {Object} variant - Variant data with annotations array
		 */
		function addAnnotations(variant) {
			if (!variant.annotations || !variant.annotations.length) return;
			if (!viewer || !viewer.world.getItemAt(0)) return;

			// getContentSize() returns the pixel dimensions of the loaded image
			var imgSize = viewer.world.getItemAt(0).getContentSize();

			variant.annotations.forEach(function (ann) {
				// Build the label element.
				// The outer div is the OSD overlay anchor (0×0, overflow visible).
				// The dot appears at the anchor point; the label extends to its right.
				// textContent is used instead of innerHTML so ann.name cannot inject HTML.
				var el = document.createElement('div');
				el.className  = 'osd-annotation';
				el.style.display = 'none'; // hidden until the toggle fires
				var dot = document.createElement('span');
				dot.className = 'osd-annotation-dot';
				var labelEl = document.createElement('span');
				labelEl.className = 'osd-annotation-label';
				labelEl.textContent = ann.name;
				el.appendChild(dot);
				el.appendChild(labelEl);

				// Convert 0-1 fraction -> image pixels -> OSD viewport coordinates.
				// imageToViewportCoordinates handles the aspect-ratio normalisation.
				var vpPt = viewer.viewport.imageToViewportCoordinates(
					ann.x * imgSize.x,
					ann.y * imgSize.y
				);

				viewer.addOverlay({ element: el, location: vpPt });
				annotationEls.push(el);
			});
		}

		/**
		 * Removes all annotation overlays from the viewer.
		 * Called before switching to a different variant's tiles.
		 */
		function clearAnnotations() {
			annotationEls.forEach(function (el) {
				if (viewer) viewer.removeOverlay(el);
				if (el.parentNode) el.parentNode.removeChild(el);
			});
			annotationEls = [];
			showingObjects = false;
		}

		// ── Close lightbox ───────────────────────────────────────────────────
		function closeLightbox() {
			lightbox.hidden = true;
			document.body.style.overflow = '';
			// Return focus to the trigger that opened the lightbox
			// so keyboard users aren't stranded
			if (lastTrigger) lastTrigger.focus();
			lastTrigger   = null;
			activeVariant = null;
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
					// Dynamic import() loads the Aladin Lite module from jsDelivr CDN.
					// Version pinned to 3.8.2 for stability.
					var mod = await import('https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js');
					var A = mod.default;

					// Mark the container as an interactive application region so
					// screen readers announce it as a sky atlas rather than
					// treating it as generic content.
					el.setAttribute('role', 'application');
					el.setAttribute('aria-label', 'Interactive sky atlas — ' + sky.aladinTarget);

					// Initialise the Aladin Lite widget.
					// The CSS selector '#' + containerId targets the unique div.
					var aladin = await A.aladin('#' + sky.containerId, {
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
					// If import() fails (network error, CDN down), show a message
					// instead of a blank widget.
					var msg = document.createElement('div');
					msg.className = 'aladin-na';
					msg.textContent = 'Sky atlas unavailable.';
					el.textContent = '';
					el.appendChild(msg);
				}
			})();
		}, { rootMargin: '300px' });

		observer.observe(el);
	}

}());
