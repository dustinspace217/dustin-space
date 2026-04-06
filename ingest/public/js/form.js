// ── tag definitions ────────────────────────────────────────────────────────
const ALL_TAGS = [
	'emission-nebula','reflection-nebula','dark-nebula','planetary-nebula',
	'supernova-remnant','galaxy','open-cluster','globular-cluster','solar','other'
];

// ── build tag chips ────────────────────────────────────────────────────────
const tagGrid = document.getElementById('tag-grid');
ALL_TAGS.forEach(tag => {
	const lbl = document.createElement('label');
	lbl.className = 'tag-chip';
	lbl.innerHTML = `<input type="checkbox" name="tags" value="${tag}"> ${tag}`;
	lbl.querySelector('input').addEventListener('change', function() {
		lbl.classList.toggle('active', this.checked);
	});
	tagGrid.appendChild(lbl);
});

// Also wire up catalog chips.
document.querySelectorAll('#cat-messier input, #cat-caldwell input').forEach(inp => {
	inp.addEventListener('change', function() {
		this.closest('.tag-chip').classList.toggle('active', this.checked);
	});
});

// ── collapsible sections ────────────────────────────────────────────────────
// Toggles the collapsed state of a form section. Called via onclick on each
// .section-header element, which passes itself as the `header` argument.
// Walks up to the parent .section div and toggles the "collapsed" class;
// CSS uses that class to hide .section-body and rotate the chevron icon.
function toggleSection(header) {
	const section = header.closest('.section');
	section.classList.toggle('collapsed');
	header.setAttribute('aria-expanded', section.classList.contains('collapsed') ? 'false' : 'true');
}

// ── slug auto-generation ────────────────────────────────────────────────────
// Converts the title field's value to a URL-safe kebab-case slug as the user
// types. Stops auto-generating once the user manually edits the slug field
// (tracked by the slugEdited flag), so a deliberate override isn't overwritten.
let slugEdited = false;
// Input listener is attached below in the slug live validation section.

function autoSlug() {
	if (slugEdited) return;
	const title = document.getElementById('f-title').value;
	const slug  = title
		.toLowerCase()
		.normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // remove diacritics
		.replace(/[^a-z0-9\s-]/g, '')
		.trim()
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-');
	document.getElementById('f-slug').value = slug;
}

// ── slug live validation ─────────────────────────────────────────────────────
// Checks the slug against images.json via GET /api/check-slug after the user
// stops typing for 400ms. Shows an inline error if the slug already exists so
// they know before submitting, not after the full pipeline runs.
//
// checkSlugTimer — holds the setTimeout ID so we can cancel on rapid keystrokes.
// The error element uses aria-live="polite" so screen readers announce the result.
let checkSlugTimer = null;

function clearSlugError() {
	const err = document.getElementById('slug-error');
	err.hidden = true;
	err.textContent = '';
	document.getElementById('f-slug').style.borderColor = '';
}

// checkSlug — called on every input event on the slug field.
// Debounces 400ms then asks the server if the slug is already taken.
// Only runs in new-target mode — in add-variant/add-revision modes the slug
// SHOULD exist (it's the parent target), so showing "already exists" is wrong.
function checkSlug() {
	clearSlugError();
	clearTimeout(checkSlugTimer);

	// f-mode is a hidden field set by the browse UI when entering a targeting mode.
	const mode = (document.getElementById('f-mode') || {}).value || 'new-target';
	if (mode !== 'new-target') return;

	const slug = document.getElementById('f-slug').value.trim();
	if (!slug) return;

	checkSlugTimer = setTimeout(async () => {
		try {
			const resp = await fetch(`/api/check-slug?slug=${encodeURIComponent(slug)}`);
			const data = await resp.json();
			if (data.exists) {
				const err = document.getElementById('slug-error');
				err.textContent = `"${slug}" already exists in images.json — choose a different slug.`;
				err.hidden = false;
				// Red border on the input as an additional visual cue.
				document.getElementById('f-slug').style.borderColor = '#f87171';
			}
		} catch (err) { console.warn('[form] Slug check failed:', err.message); }
	}, 400);
}

document.getElementById('f-slug').addEventListener('input', () => {
	slugEdited = true;
	checkSlug();
});

// ── default date to today ───────────────────────────────────────────────────
document.getElementById('f-date').value = new Date().toISOString().slice(0, 10);

// ── file drop zones ─────────────────────────────────────────────────────────
// Four functions handle drag-and-drop and click-to-browse file selection.
// Called by inline event attributes in the HTML (ondragover, ondrop, etc.).
//
// onDragOver  — e.preventDefault() is required; without it the browser opens
//               the file directly instead of firing the drop event.
//               Adds .drag-over for the visual highlight style.
// onDragLeave — removes the highlight when the drag exits the zone.
// onDrop      — extracts the dropped file and calls setDropFile().
//               type is 'jpg' or 'tif' (controls which drop zone to update).
// onFileChange — same outcome as a drop, triggered by the file input's
//               change event when the user clicks to browse.
function onDragOver(e, zone) {
	e.preventDefault();
	zone.classList.add('drag-over');
}
function onDragLeave(zone) {
	zone.classList.remove('drag-over');
}
function onDrop(e, type) {
	e.preventDefault();
	const zone = document.getElementById(`${type}-drop`);
	zone.classList.remove('drag-over');
	const file = e.dataTransfer.files[0];
	if (file) setDropFile(type, file, zone);
}
function onFileChange(e, type) {
	const zone = document.getElementById(`${type}-drop`);
	const file = e.target.files[0];
	if (file) setDropFile(type, file, zone);
}

// Updates the drop zone UI and wires the file into the hidden <input type="file">
// so FormData includes it when the form is submitted.
//
// type — 'jpg' or 'tif' — controls which name element to update
// file — the File object from dataTransfer.files[0] or input.files[0]
// zone — the .drop-zone element to mark as .has-file
//
// For JPG: also shows a thumbnail preview using a blob URL.
// For TIF: fires a /api/metadata POST to pre-populate equipment/WCS fields
//          from FITS/EXIF data embedded in the TIF.
function setDropFile(type, file, zone) {
	zone.classList.add('has-file');
	document.getElementById(`${type}-name`).textContent = file.name;

	// Assign the file to the hidden <input type="file"> so FormData picks it up
	// on submit. file inputs can't be set via .value, but DataTransfer lets us
	// build a FileList programmatically and assign it to input.files.
	const input = zone.querySelector('input[type="file"]');
	if (input) {
		const dt = new DataTransfer();
		dt.items.add(file);
		input.files = dt.files;
	}

	if (type === 'jpg') {
		// Show thumbnail preview for the JPG.
		const preview = document.getElementById('jpg-preview');
		const url = URL.createObjectURL(file);
		preview.src = url;
		preview.style.display = 'block';
		preview.onload = () => URL.revokeObjectURL(url);
	}

	if (type === 'tif') {
		// Read metadata from the TIF via the server.
		const fd = new FormData();
		fd.append('tif', file);
		fetch('/api/metadata', { method: 'POST', body: fd })
			.then(r => r.json())
			.then(data => applyMetadata(data))
			.catch(err => console.warn('[form] Metadata fetch failed:', err.message));
	}
}

// Auto-populate form fields from FITS/EXIF metadata extracted by the server.
// Called after a TIF is dropped; the server extracts known fields via exiftool
// and returns a flat object. Only fills fields that are currently empty —
// never overwrites anything the user has already typed.
//
// data — plain object returned by /api/metadata; keys include:
//        object (target name), telescop, instrume, software, dateObs,
//        ra, dec, imageDesc. Any key may be absent if exiftool didn't find it.
function applyMetadata(data) {
	if (!data || !Object.keys(data).length) return;

	if (data.object && !document.getElementById('f-title').value) {
		document.getElementById('f-title').value = data.object;
		autoSlug();
	}
	if (data.telescop && !document.getElementById('f-telescope').value)
		document.getElementById('f-telescope').value = data.telescop;
	if (data.instrume && !document.getElementById('f-camera').value)
		document.getElementById('f-camera').value = data.instrume;
	if (data.software && !document.getElementById('f-software').value)
		document.getElementById('f-software').value = data.software;
	if (data.dateObs) {
		const d = new Date(data.dateObs);
		if (!isNaN(d)) document.getElementById('f-date').value = d.toISOString().slice(0,10);
	}
	if (data.ra  !== undefined) document.getElementById('f-ra').value  = parseFloat(data.ra).toFixed(4);
	if (data.dec !== undefined) document.getElementById('f-dec').value = parseFloat(data.dec).toFixed(4);
}

// ── equipment presets ────────────────────────────────────────────────────────
let equipmentData = { personal: [], itelescope: [] };

fetch('/api/equipment')
	.then(r => r.json())
	.then(data => {
		equipmentData = data;
		const pgP = document.getElementById('optgroup-personal');
		const pgI = document.getElementById('optgroup-itel');

		data.personal.forEach(e => {
			const opt = new Option(e.label, e.id);
			pgP.appendChild(opt);
		});
		data.itelescope.forEach(e => {
			const opt = new Option(e.label, e.id);
			pgI.appendChild(opt);
		});
	})
	.catch(err => console.warn('[form] Equipment fetch failed:', err.message));

// Fills equipment form fields from the selected preset in the Equipment Preset
// dropdown. The preset list is loaded from /api/equipment at page load and
// stored in equipmentData (personal and itelescope arrays).
//
// Reads the selected value from #equip-preset (an equipment id string or "custom").
// Does nothing if "custom" is selected or if the id doesn't match any preset.
// Only sets fields that are currently empty — won't overwrite user edits.
// Also writes to the hidden f-fov-hint field used by ASTAP for plate-solving.
function applyPreset() {
	const id = document.getElementById('equip-preset').value;
	if (!id || id === 'custom') return;

	const all  = [...equipmentData.personal, ...equipmentData.itelescope];
	const preset = all.find(e => e.id === id);
	if (!preset) return;

	// Fill each equipment field only if it's currently empty.
	// Checking !el.value prevents overwriting anything the user has already typed.
	const set = (fieldId, val) => {
		const el = document.getElementById(fieldId);
		if (el && val && !el.value) el.value = val;
	};

	set('f-telescope',  preset.telescope);
	set('f-camera',     preset.camera);
	set('f-mount',      preset.mount);
	set('f-guider',     preset.guider);
	set('f-filterlist', preset.filters_default);
	set('f-location',   preset.location);
	set('f-software',   preset.software);

	// Store the FOV hint for ASTAP from the preset's field of view.
	if (preset.fov_w_deg) {
		const fov = Math.max(preset.fov_w_deg, preset.fov_h_deg || 0).toFixed(2);
		document.getElementById('f-fov-hint').value  = fov;
		document.getElementById('f-fov-manual').value = fov;
	}
}

// ── filter rows ────────────────────────────────────────────────────────────
let filterCount = 0;

// Adds one filter row to the acquisition table. Enforces a max of 7 rows.
// name, frames, minutes — optional pre-fill values (default to empty string).
//   Passed by setFilterPreset() when restoring a named filter set.
//   User typically fills these manually after the row is added.
// Wires oninput on the frames/sec fields to keep updateTotalTime() current.
function addFilterRow(name = '', frames = '', minutes = '') {
	if (filterCount >= 7) return;
	filterCount++;

	const tbody = document.getElementById('filter-rows');
	const tr    = document.createElement('tr');
	tr.dataset.idx = filterCount;

	// Build cells with createElement + value assignment instead of innerHTML
	// to prevent user-supplied values (from localStorage restore or presets)
	// from being interpreted as HTML.
	function makeInput(attrs) {
		const inp = document.createElement('input');
		for (const [k, v] of Object.entries(attrs)) inp[k] = v;
		return inp;
	}

	// Filter name cell
	const tdName = document.createElement('td');
	tdName.appendChild(makeInput({ type: 'text', name: 'filterName', value: name, placeholder: 'Hα', className: 'mono' }));
	tr.appendChild(tdName);

	// Frames cell
	const tdFrames = document.createElement('td');
	const framesInp = makeInput({ type: 'number', name: 'filterFrames', value: frames, placeholder: '54', min: '1' });
	framesInp.addEventListener('input', function() { calcMinutes(this); });
	tdFrames.appendChild(framesInp);
	tr.appendChild(tdFrames);

	// Minutes cell
	const tdMin = document.createElement('td');
	tdMin.appendChild(makeInput({ type: 'number', name: 'filterMinutes', value: minutes, placeholder: '270', min: '1' }));
	tr.appendChild(tdMin);

	// Seconds-per-frame cell
	const tdSec = document.createElement('td');
	const secInp = makeInput({ type: 'number', className: 'sec-field', placeholder: '300', min: '1', step: '1', title: 'Seconds per frame — auto-calculates minutes' });
	secInp.addEventListener('input', function() { calcMinutes(this); });
	tdSec.appendChild(secInp);
	tr.appendChild(tdSec);

	// Remove button cell
	const tdBtn = document.createElement('td');
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'btn-icon';
	btn.textContent = '✕';
	btn.addEventListener('click', function() { removeFilterRow(this); });
	tdBtn.appendChild(btn);
	tr.appendChild(tdBtn);

	tbody.appendChild(tr);
	updateTotalTime();
	tr.querySelectorAll('input').forEach(inp => inp.addEventListener('input', updateTotalTime));
}

// Auto-calculates the minutes field when frames count or seconds-per-frame changes.
// inp — the input element that triggered the change (filterFrames or .sec-field).
// Walks up to the parent <tr> to find both sibling inputs.
// Formula: minutes = round(frames × seconds_per_frame / 60).
// Only writes if both frames and seconds are non-zero.
function calcMinutes(inp) {
	const row     = inp.closest('tr');
	const frames  = parseInt(row.querySelector('[name="filterFrames"]').value, 10)  || 0;
	const secEl   = row.querySelector('.sec-field');
	const sec     = parseInt(secEl ? secEl.value : 0, 10) || 0;
	if (frames && sec) {
		const minEl = row.querySelector('[name="filterMinutes"]');
		minEl.value = Math.round(frames * sec / 60);
	}
	updateTotalTime();
}

// Removes the filter table row containing the clicked delete button.
// btn — the ✕ button element; .closest('tr') walks up to its parent row.
// Decrements filterCount so a new row can be added in its place.
function removeFilterRow(btn) {
	btn.closest('tr').remove();
	filterCount = Math.max(0, filterCount - 1);
	updateTotalTime();
}

// Recalculates and displays the total imaging time across all filter rows.
// Reads all [name="filterMinutes"] inputs, sums their values, and writes
// a human-readable "Xh Ym" string to #total-time. Clears if total is 0.
// Called whenever a filter row is added, removed, or edited.
function updateTotalTime() {
	let total = 0;
	document.querySelectorAll('[name="filterMinutes"]').forEach(inp => {
		total += parseInt(inp.value, 10) || 0;
	});
	const el = document.getElementById('total-time');
	if (total > 0) {
		const h = Math.floor(total / 60);
		const m = total % 60;
		el.textContent = `Total imaging time: ${h}h ${m}m`;
	} else {
		el.textContent = '';
	}
}

// Pre-fill filter rows from common presets.
// Each value is an array of [name, frames, minutes] tuples — frames and minutes
// start empty so the user fills in the exposure details after selecting.
const FILTER_PRESETS = {
	'LRGB':    [['L','',''],['R','',''],['G','',''],['B','','']],
	'HOO':     [['Hα','',''],['OIII','','']],
	'SHO':     [['SII','',''],['Hα','',''],['OIII','','']],
	'SHOLRGB': [['SII','',''],['Hα','',''],['OIII','',''],['L','',''],['R','',''],['G','',''],['B','','']],
	'Ha':      [['Hα','','']],
	'OSC':     [['OSC','','']],
};

// Clears the filter rows table and pre-populates it from the named filter set.
// key — one of 'LRGB', 'HOO', 'SHO', 'SHOLRGB', 'Ha', 'OSC'.
// Frames and minutes start empty so the user fills in the exposure details.
function setFilterPreset(key) {
	const rows = FILTER_PRESETS[key];
	if (!rows) return;
	// Clear existing rows.
	document.getElementById('filter-rows').innerHTML = '';
	filterCount = 0;
	rows.forEach(([name, frames, mins]) => addFilterRow(name.trim(), frames, mins));
}

// ── localStorage form persistence ─────────────────────────────────────────
// Saves equipment/options state under key "ingest-form-{title}" in localStorage.
// On title blur, checks for an existing save and offers to restore it.
//
// Fields saved: telescope, camera, mount, guider, filterList, location,
//   software, platesolve, simbad, dzi, gitpush, featured, and all filter rows.
// Fields NOT saved: slug, date, astrobin_id, description (unique per image).

// localStorageKey — derives the localStorage key from a title string.
// title — raw string from the title input; lowercased + trimmed for the key.
// Returns a string like "ingest-form-the-horsehead-nebula".
function localStorageKey(title) {
	return 'ingest-form-' + title.toLowerCase().trim();
}

// saveFormToLocalStorage — serialises the saveable form fields and writes them
// to localStorage under the key derived from the title.
// title — the current title field value (used to build the key).
// Called on 'done' (successful publish) and also on title blur so partial work
// is saved even if the user never finishes.
function saveFormToLocalStorage(title) {
	if (!title) return;

	// Gather filter rows — each row has three inputs: filterName, filterFrames, filterMinutes.
	const filterRows = [];
	document.querySelectorAll('#filter-rows tr').forEach(tr => {
		const name    = tr.querySelector('[name="filterName"]')?.value    || '';
		const frames  = tr.querySelector('[name="filterFrames"]')?.value  || '';
		const minutes = tr.querySelector('[name="filterMinutes"]')?.value || '';
		if (name) filterRows.push({ name, frames, minutes });
	});

	// Helper: read a checkbox value as boolean.
	const chk = id => document.getElementById(id)?.checked ?? false;

	const state = {
		telescope:  document.getElementById('f-telescope')?.value  || '',
		camera:     document.getElementById('f-camera')?.value     || '',
		mount:      document.getElementById('f-mount')?.value      || '',
		guider:     document.getElementById('f-guider')?.value     || '',
		filterList: document.getElementById('f-filterlist')?.value || '',
		location:   document.getElementById('f-location')?.value   || '',
		software:   document.getElementById('f-software')?.value   || '',
		// Pipeline option toggles — stored as booleans.
		platesolve: chk('opt-platesolve'),
		simbad:     chk('opt-simbad'),
		dzi:        chk('opt-dzi'),
		gitpush:    chk('opt-gitpush'),
		featured:   chk('f-featured'),
		// Tag chip selections — store the value of every checked tag checkbox.
		tags:       [...document.querySelectorAll('[name="tags"]:checked')].map(i => i.value),
		// Catalog checkboxes.
		catalogs:   [...document.querySelectorAll('[name="catalogs"]:checked')].map(i => i.value),
		// Filter acquisition rows.
		filterRows,
	};

	try {
		localStorage.setItem(localStorageKey(title), JSON.stringify(state));
	} catch (err) { console.warn('[form] localStorage save failed:', err.message); }
}

// checkLocalStorageRestore — called on title input blur (onblur="checkLocalStorageRestore()").
// If a saved state exists for the typed title, shows the restore banner.
// The banner offers "Restore" and "Dismiss" buttons.
function checkLocalStorageRestore() {
	const title = document.getElementById('f-title').value.trim();
	const banner = document.getElementById('restore-banner');
	if (!title) { banner.classList.remove('visible'); return; }

	const key   = localStorageKey(title);
	const saved = localStorage.getItem(key);
	if (!saved) { banner.classList.remove('visible'); return; }

	// Show the banner with the title name for clarity.
	document.getElementById('restore-banner-text').textContent =
		`Restore previous settings for "${title}"?`;
	banner.classList.add('visible');
}

// applyLocalStorageRestore — called by the "Restore" button in the restore banner.
// Reads the saved state and fills the form fields.
// Fields that are unique per image (slug, date, astrobin_id, description) are
// intentionally left untouched.
function applyLocalStorageRestore() {
	const title = document.getElementById('f-title').value.trim();
	if (!title) return;

	let state;
	try {
		state = JSON.parse(localStorage.getItem(localStorageKey(title)) || 'null');
	} catch (err) {
		console.warn('[form] localStorage restore parse failed:', err.message);
		state = null;
	}

	if (!state) return;

	// Helper: set a text input value if the key exists in state.
	const set = (id, val) => {
		const el = document.getElementById(id);
		if (el && val !== undefined) el.value = val;
	};

	set('f-telescope',  state.telescope);
	set('f-camera',     state.camera);
	set('f-mount',      state.mount);
	set('f-guider',     state.guider);
	set('f-filterlist', state.filterList);
	set('f-location',   state.location);
	set('f-software',   state.software);

	// Restore pipeline option checkboxes.
	// Each toggle has a checkbox element whose id is opt-platesolve etc.
	const setChk = (id, val) => {
		const el = document.getElementById(id);
		if (el && val !== undefined) el.checked = !!val;
	};
	setChk('opt-platesolve', state.platesolve);
	setChk('opt-simbad',     state.simbad);
	setChk('opt-dzi',        state.dzi);
	setChk('opt-gitpush',    state.gitpush);
	setChk('f-featured',     state.featured);

	// Restore tag chip selections.
	// Each tag chip's <input type="checkbox"> has name="tags" and a specific value.
	if (Array.isArray(state.tags)) {
		document.querySelectorAll('[name="tags"]').forEach(inp => {
			const wasChecked = state.tags.includes(inp.value);
			inp.checked = wasChecked;
			inp.closest('.tag-chip')?.classList.toggle('active', wasChecked);
		});
	}

	// Restore catalog chip selections.
	if (Array.isArray(state.catalogs)) {
		document.querySelectorAll('[name="catalogs"]').forEach(inp => {
			const wasChecked = state.catalogs.includes(inp.value);
			inp.checked = wasChecked;
			inp.closest('.tag-chip')?.classList.toggle('active', wasChecked);
		});
	}

	// Restore filter rows — clear existing rows first, then re-add from saved state.
	if (Array.isArray(state.filterRows) && state.filterRows.length) {
		document.getElementById('filter-rows').innerHTML = '';
		filterCount = 0;
		state.filterRows.forEach(r => addFilterRow(r.name, r.frames, r.minutes));
	}

	// Hide the banner after restoring.
	dismissRestore();
}

// dismissRestore — hides the restore banner without applying changes.
// Called by the "Dismiss" button in the restore banner.
function dismissRestore() {
	document.getElementById('restore-banner').classList.remove('visible');
}

// Also save on every title blur (not just successful publishes) so partial
// work is preserved even if the user never finishes a run.
document.getElementById('f-title').addEventListener('blur', () => {
	const title = document.getElementById('f-title').value.trim();
	if (title) saveFormToLocalStorage(title);
});
