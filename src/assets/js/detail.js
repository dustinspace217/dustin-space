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
 * Loaded with `defer` so it runs after the DOM is parsed but before DOMContentLoaded.
 */

(function () {
	'use strict';

	// ── Read the JSON data bridge ─────────────────────────────────────────────
	// The <script type="application/json"> block is rendered by Nunjucks in image.njk.
	// It contains image-specific data: DZI URLs, annotations, sky coordinates, etc.
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

	// ── Initialize each concern ───────────────────────────────────────────────
	if (data.dziUrl) {
		initLightbox(data);
	}
	if (data.sky) {
		initAladin(data);
	}


	// ═══════════════════════════════════════════════════════════════════════════
	//  LIGHTBOX — OpenSeadragon deep zoom viewer
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * initLightbox — sets up the full-viewport OSD lightbox.
	 *
	 * Receives the parsed JSON bridge object. Expects:
	 *   data.dziUrl         — URL to the DZI manifest on R2
	 *   data.annotatedDziUrl — optional annotated tile source URL
	 *   data.annotations    — array of { name, x, y } overlay objects
	 *
	 * OSD is loaded lazily — it doesn't initialize until the user clicks the
	 * zoom trigger. The lightbox covers 100vw × 100vh with body scroll locked.
	 * Escape key or the Close button dismisses it.
	 */
	function initLightbox(data) {
		var dziUrl       = data.dziUrl;
		var annotatedUrl = data.annotatedDziUrl;
		var annotations  = data.annotations || [];

		var lightbox    = document.getElementById('zoom-lightbox');
		var trigger     = document.getElementById('zoom-trigger');
		var closeBtn    = document.getElementById('lightbox-close');
		var annotBtn    = document.getElementById('annotate-toggle');
		var objectsBtn  = document.getElementById('objects-toggle');

		if (!lightbox || !trigger) return;

		// OSD instance — created once on first open, reused on subsequent opens
		var viewer = null;

		// Annotation overlay elements — populated after OSD loads the first tile set.
		// Each element is a div positioned by OSD at the annotation's image coordinates.
		var annotationEls     = [];
		var showingObjects    = false;
		var showingAnnotated  = false;

		// Flag to ensure annotBtn/objectsBtn listeners are registered only once.
		// Without this guard, an open-failed → viewer=null → reopen cycle re-runs
		// the if(!viewer) block and adds duplicate handlers on every reopen.
		var listenersRegistered = false;

		// ── Open lightbox ────────────────────────────────────────────────────
		function openLightbox() {
			lightbox.hidden = false;
			// Lock page scroll so the user can't accidentally scroll
			// the page while panning inside the lightbox
			document.body.style.overflow = 'hidden';

			// Initialize OSD on first open only — lazy so tiles don't
			// start downloading until the user actually wants to zoom
			if (!viewer) {
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
					tileSources: dziUrl,

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
					annotationEls = [];
					showingObjects = false;
					if (objectsBtn) {
						objectsBtn.textContent = 'Show Objects';
						objectsBtn.setAttribute('aria-pressed', 'false');
					}
					showingAnnotated = false;
					if (annotBtn) {
						annotBtn.textContent = 'Show Annotations';
						annotBtn.setAttribute('aria-pressed', 'false');
					}
					var errEl = document.createElement('div');
					errEl.className = 'osd-error';
					errEl.textContent = 'Could not load image tiles. Check that the DZI file and tile folder are uploaded to R2.';
					el.textContent = '';
					el.appendChild(errEl);
				});

				// ── Catalog object overlay (platesolve-style labels) ────────────
				// After the first tile set is loaded, create a DOM overlay element
				// for each annotation and register it with OSD at the correct
				// viewport position. OSD keeps the element locked to that position
				// as the user pans and zooms.
				if (annotations.length) {
					viewer.addHandler('open', function () {
						// Only add overlays once (guard against the open event firing
						// again when annotated tile source is swapped in)
						if (annotationEls.length) return;

						// getContentSize() returns the pixel dimensions of the loaded image
						var imgSize = viewer.world.getItemAt(0).getContentSize();

						annotations.forEach(function (ann) {
							// Build the label element.
							// The outer div is the OSD overlay anchor (0x0, overflow visible).
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
					});
				}
			}

			// ── Register click handlers once ─────────────────────────────────────
			// Kept outside the if(!viewer) block so an open-failed → viewer=null →
			// reopen cycle does not add duplicate listeners on each reopen.
			if (!listenersRegistered) {
				listenersRegistered = true;

				// Tile-source annotation toggle (only when annotated_dzi_url is set)
				if (annotBtn && annotatedUrl) {
					annotBtn.addEventListener('click', function () {
						if (!viewer) return;
						showingAnnotated = !showingAnnotated;
						viewer.open(showingAnnotated ? annotatedUrl : dziUrl);
						annotBtn.textContent = showingAnnotated ? 'Hide Annotations' : 'Show Annotations';
						annotBtn.setAttribute('aria-pressed', showingAnnotated ? 'true' : 'false');
					});
				}

				// Toggle all annotation labels on/off
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

		// ── Close lightbox ───────────────────────────────────────────────────
		function closeLightbox() {
			lightbox.hidden = true;
			document.body.style.overflow = '';
			// Return focus to the trigger so keyboard users aren't stranded
			if (trigger) trigger.focus();
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
		trigger.addEventListener('click',  openLightbox);
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
	 * initAladin — lazy-loads Aladin Lite via IntersectionObserver.
	 *
	 * Receives the parsed JSON bridge object. Expects:
	 *   data.sky.aladinTarget — Simbad-resolvable name (e.g. "M42")
	 *   data.sky.fovDeg       — field of view in degrees
	 *   data.sky.raDeg        — RA in decimal degrees (for FoV rectangle)
	 *   data.sky.decDeg       — Dec in decimal degrees
	 *   data.sky.fovW         — camera FoV width in degrees
	 *   data.sky.fovH         — camera FoV height in degrees
	 *
	 * The Aladin Lite library (~1MB) is loaded via dynamic import() only
	 * when the widget scrolls near the viewport (300px margin).
	 */
	function initAladin(data) {
		var sky = data.sky;
		var el  = document.getElementById('aladin-lite-div');
		if (!el || !sky.aladinTarget) return;

		// IntersectionObserver defers initialization until the widget is
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

					// Initialize the Aladin Lite widget
					var aladin = await A.aladin('#aladin-lite-div', {
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
