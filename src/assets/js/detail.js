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
		var objectsBtn = document.getElementById('objects-toggle');

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
				// Uses dziToOpen which accounts for the active revision.
				clearAnnotations();
				viewer.open(dziToOpen);
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
			var afterImg = document.createElement('img');
			afterImg.src = afterSrc;
			afterImg.alt = afterLabel;
			afterImg.className = 'cs-img cs-img--after';

			// "Before" image — sits on top, clipped from the right by clip-path.
			// At 50% position, the left half shows "before", right half shows "after".
			var beforeImg = document.createElement('img');
			beforeImg.src = beforeSrc;
			beforeImg.alt = beforeLabel;
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
