/**
 * browse.js — Gallery browser with variant/revision targeting
 *
 * Fetches existing gallery data from GET /api/gallery and renders a grid
 * of tiles. Each tile can be expanded to show its variants and revisions.
 * Action buttons let the user target an existing entry for add-variant
 * or add-revision mode, which sets hidden form inputs and switches to
 * the form tab.
 *
 * Depends on:
 *   - form.js (loaded first) — autoSlug(), toggleSection()
 *   - pipeline.js (loaded first) — no direct dependency, but shares DOM
 *
 * Global functions defined here (called from inline HTML handlers):
 *   switchTab(tabName)       — toggles between 'browse' and 'form' tabs
 *   clearTargetingMode()     — resets mode to 'new-target' and clears hidden inputs
 *   loadGallery()            — fetches and renders the gallery grid
 */

// ── state ──────────────────────────────────────────────────────────────────
// galleryData holds the full images.json array fetched from the server.
// It's refreshed each time the Browse tab is activated.
let galleryData = [];

// ── helper: create an element with optional classes and text ────────────
// tag      — HTML tag name (e.g. 'div', 'span', 'button')
// classes  — space-separated CSS class string (e.g. 'browse-tile-title')
// text     — optional text content (set via textContent, safe against XSS)
// Returns the created HTMLElement for further manipulation.
function el(tag, classes, text) {
	const e = document.createElement(tag);
	if (classes) e.className = classes;
	if (text !== undefined) e.textContent = text;
	return e;
}

// ── tab switching ──────────────────────────────────────────────────────────
// tabName is 'form' or 'browse'. Toggles visibility of the form and browse
// panels, updates the active tab button style, and triggers a gallery load
// when switching to the browse tab.

function switchTab(tabName) {
	// Update tab button active states and ARIA attributes.
	document.querySelectorAll('.tab').forEach(function(btn) {
		var isActive = btn.dataset.tab === tabName;
		btn.classList.toggle('active', isActive);
		btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
	});

	// Toggle panel visibility.
	var browsePanel = document.getElementById('browse-panel');
	var formEl      = document.getElementById('ingest-form');

	if (tabName === 'browse') {
		browsePanel.classList.add('visible');
		formEl.style.display = 'none';
		loadGallery();
	} else {
		browsePanel.classList.remove('visible');
		formEl.style.display = '';
	}
}

// ── gallery loading ────────────────────────────────────────────────────────
// Fetches the gallery data from /api/gallery and renders the browse grid.
// Called when the Browse tab is activated.

async function loadGallery() {
	var grid    = document.getElementById('gallery-grid');
	var loading = document.getElementById('browse-loading');

	loading.style.display = 'block';
	grid.textContent = '';

	try {
		var resp = await fetch('/api/gallery');
		galleryData = await resp.json();
	} catch (e) {
		loading.textContent = 'Failed to load gallery data.';
		return;
	}

	loading.style.display = 'none';

	if (!galleryData.length) {
		var msg = el('p', 'browse-loading', 'No images yet. Use the New Image tab to add your first target.');
		grid.appendChild(msg);
		return;
	}

	// Render one tile per target.
	galleryData.forEach(function(target) {
		var tile = buildTile(target);
		grid.appendChild(tile);
	});
}

// ── tile builder ───────────────────────────────────────────────────────────
// Creates the DOM for one gallery tile, including the thumbnail, info bar,
// and expandable variant/revision panel. Uses safe DOM construction
// (createElement + textContent) rather than innerHTML to prevent XSS.

function buildTile(target) {
	var tile = el('div', 'browse-tile');

	// Find the primary variant (or fall back to the first one).
	var primaryVariant = target.variants.find(function(v) { return v.primary; }) || target.variants[0];
	// Thumbnail image path — served from the static gallery directory.
	var thumbUrl = primaryVariant ? primaryVariant.thumbnail : '';

	// Tile image.
	var img = document.createElement('img');
	img.className = 'browse-tile-img';
	img.src = thumbUrl || '';
	img.alt = target.title;
	img.loading = 'lazy';
	img.onerror = function() { this.style.display = 'none'; };
	tile.appendChild(img);

	// Tile info bar: title + metadata.
	var info = el('div', 'browse-tile-info');

	var titleEl = el('div', 'browse-tile-title', target.title);
	info.appendChild(titleEl);

	var metaText = (target.catalog || target.slug) +
		' \u00B7 ' + target.variants.length +
		' variant' + (target.variants.length !== 1 ? 's' : '');
	var metaEl = el('div', 'browse-tile-meta', metaText);
	info.appendChild(metaEl);

	tile.appendChild(info);

	// Variant panel — initially hidden, shown on tile click (.expanded class).
	var panel = el('div', 'variant-panel');

	// Render each variant as a row with action buttons.
	target.variants.forEach(function(variant) {
		var row = el('div', 'variant-row');

		// Left side: variant name + date + revision count.
		var leftDiv = el('div');
		leftDiv.appendChild(el('span', 'variant-name', variant.label || variant.id));
		leftDiv.appendChild(el('span', 'variant-date', variant.date || ''));
		if (variant.revisions.length) {
			leftDiv.appendChild(el('span', 'variant-date', '(' + variant.revisions.length + ' rev)'));
		}
		row.appendChild(leftDiv);

		// Right side: action button.
		var actions = el('div', 'browse-actions');
		var revBtn = el('button', 'btn-browse-action', '+ Revision');
		revBtn.type = 'button';
		// event.stopPropagation() prevents the tile's click (expand/collapse)
		// from also firing when the button is clicked.
		// forEach already creates per-iteration scope for let/const, so no IIFE needed.
		revBtn.addEventListener('click', function(e) {
			e.stopPropagation();
			startAddRevision(target.slug, variant.id);
		});
		actions.appendChild(revBtn);
		row.appendChild(actions);
		panel.appendChild(row);

		// Show existing revisions if any.
		if (variant.revisions.length) {
			var revList = el('div', 'revision-list');
			variant.revisions.forEach(function(rev) {
				var item = el('div', 'revision-item');
				item.appendChild(el('span', '', rev.label || rev.id));
				item.appendChild(el('span', 'variant-date', rev.date || ''));
				if (rev.is_final) {
					item.appendChild(el('span', 'is-final', 'FINAL'));
				}
				revList.appendChild(item);
			});
			panel.appendChild(revList);
		}
	});

	// "Add Variant" button at the bottom of the variant panel.
	var footer = el('div');
	footer.style.cssText = 'margin-top: 8px; text-align: center;';
	var addVarBtn = el('button', 'btn-browse-action', '+ Add Variant');
	addVarBtn.type = 'button';
	addVarBtn.addEventListener('click', function(e) {
		e.stopPropagation();
		startAddVariant(target.slug, target.title);
	});
	footer.appendChild(addVarBtn);
	panel.appendChild(footer);

	tile.appendChild(panel);

	// Toggle expanded state on tile click.
	tile.addEventListener('click', function() {
		tile.classList.toggle('expanded');
	});

	return tile;
}

// ── targeting mode setters ─────────────────────────────────────────────────
// Called by action buttons in the browse panel. Set hidden form inputs
// and switch to the form tab with the mode banner visible.

// startAddVariant — user clicked "+ Add Variant" on a target.
// Sets mode to 'add-variant', fills parentSlug, and prompts for a variant ID.
function startAddVariant(slug, title) {
	var variantId = prompt('Enter a variant ID for "' + title + '" (e.g. "widefield", "mosaic"):');
	if (!variantId) return;

	var cleanId = variantId.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
	if (!cleanId) return;

	document.getElementById('f-mode').value = 'add-variant';
	document.getElementById('f-parent-slug').value = slug;
	document.getElementById('f-variant-id').value = cleanId;

	// Optionally ask for a label (displayed in the gallery).
	var label = prompt('Label for this variant (or leave blank for "' + cleanId + '"):');
	document.getElementById('f-variant-label').value = (label || '').trim();

	showModeBanner('Adding variant "' + cleanId + '" to ' + title + ' (' + slug + ')');
	switchTab('form');
}

// startAddRevision — user clicked "+ Revision" on a variant.
// Sets mode to 'add-revision', fills parentSlug and parentVariantId,
// and prompts for a revision ID.
function startAddRevision(slug, variantId) {
	var target = galleryData.find(function(t) { return t.slug === slug; });
	var title  = target ? target.title : slug;

	var revisionId = prompt('Enter a revision ID for "' + title + '" / ' + variantId + ' (e.g. "v2", "reprocess-2024"):');
	if (!revisionId) return;

	var cleanId = revisionId.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
	if (!cleanId) return;

	document.getElementById('f-mode').value = 'add-revision';
	document.getElementById('f-parent-slug').value = slug;
	document.getElementById('f-parent-variant-id').value = variantId;
	document.getElementById('f-revision-id').value = cleanId;

	// Ask for optional label and final status.
	var label = prompt('Label for this revision (or leave blank for "' + cleanId + '"):');
	document.getElementById('f-revision-label').value = (label || '').trim();

	var isFinal = confirm('Mark this revision as the final/current version?');
	document.getElementById('f-is-final').value = isFinal ? 'true' : 'false';

	// Prompt for an optional revision note — stored in images.json as revisionObj.note.
	// Useful for recording what changed (e.g. "reprocessed with BlurXTerminator").
	var note = prompt('Revision note (optional — what changed?):');
	document.getElementById('f-revision-note').value = (note || '').trim();

	showModeBanner('Adding revision "' + cleanId + '" to ' + title + ' / ' + variantId);
	switchTab('form');
}

// showModeBanner — displays the amber mode banner above the form.
// text — the human-readable description of the current targeting mode.
function showModeBanner(text) {
	var banner = document.getElementById('mode-banner');
	document.getElementById('mode-banner-text').textContent = text;
	banner.classList.add('visible');
}

// clearTargetingMode — resets all hidden mode inputs back to new-target defaults.
// Called by the mode banner "Clear" button and the browse panel "+ New Target" button.
function clearTargetingMode() {
	document.getElementById('f-mode').value = 'new-target';
	document.getElementById('f-parent-slug').value = '';
	document.getElementById('f-parent-variant-id').value = '';
	document.getElementById('f-variant-id').value = '';
	document.getElementById('f-variant-label').value = '';
	document.getElementById('f-revision-id').value = '';
	document.getElementById('f-revision-label').value = '';
	document.getElementById('f-revision-note').value = '';
	document.getElementById('f-is-final').value = 'false';

	// Hide the mode banner.
	document.getElementById('mode-banner').classList.remove('visible');
}
