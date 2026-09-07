/**
 * Exercise the production annotation-state functions with a deterministic
 * clock. OpenSeadragon and image downloads are irrelevant to the timer race.
 * Extracting the existing closure functions keeps their behavior intact while
 * avoiding a new public application API solely for this regression test.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/assets/js/detail.js'), 'utf8');

/** Read one complete named closure function; fail if its source boundary changes. */
function extract(name) {
	const start = source.indexOf('\t\tfunction ' + name + '(');
	assert.ok(start >= 0, `missing production function: ${name}`);
	const end = source.indexOf('\n\t\t}', start);
	assert.ok(end > start, `missing function boundary: ${name}`);
	return source.slice(start, end + '\n\t\t}'.length);
}

/** Build isolated DOM-class and clock state, returning the real toggle functions. */
function harness() {
	const classes = new Set(['osd-annotation--hidden']);
	const timers = new Map();
	let nextTimer = 0;
	const context = {
		hasFlashedAnnotations: false, showingObjects: false,
		activeCategories: { stars: true }, filterChipBar: { hidden: true },
		gridCanvas: null, objectsBtn: null, flashTimerA: null, flashTimerB: null,
		annotationEls: [{
			getAttribute: () => 'stars',
			classList: {
				add: name => { classes.add(name); },
				remove: name => { classes.delete(name); },
				toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
			},
		}],
		showGrid: () => {}, hideGrid: () => {},
		window: { matchMedia: () => ({ matches: false }) },
		setTimeout: (callback, delay) => {
			assert.ok(timers.size < 2, 'flash may have at most two pending timers');
			timers.set(++nextTimer, { callback, delay });
			return nextTimer;
		},
		clearTimeout: id => { timers.delete(id); },
	};
	vm.createContext(context);
	vm.runInContext(['flashAnnotations', 'toggleObjects', 'applyAnnotationVisibility'].map(extract).join('\n'), context, { timeout: 1000 });
	return { context, classes, timers };
}

for (const phase of ['reveal', 'fade', 'finished']) {
	test(`Objects takes control during ${phase} and preserves category selection`, () => {
		const { context, classes, timers } = harness();
		context.flashAnnotations({ annotations: [{}] });
		if (phase !== 'reveal') {
			const first = timers.get(context.flashTimerA);
			timers.delete(context.flashTimerA);
			first.callback();
		}
		if (phase === 'finished') {
			const second = timers.get(context.flashTimerB);
			timers.delete(context.flashTimerB);
			second.callback();
		}
		context.toggleObjects();
		assert.equal(context.showingObjects, true);
		assert.equal(timers.size, 0, 'automatic flash must stop once the visitor takes control');
		assert.equal(classes.has('osd-annotation--fade-out'), false);
		assert.equal(classes.has('osd-annotation--hidden'), false);
		assert.equal(context.filterChipBar.hidden, false);
		context.activeCategories.stars = false;
		context.toggleObjects();
		context.toggleObjects();
		assert.equal(classes.has('osd-annotation--hidden'), true, 'off/on preserves disabled categories');
		assert.equal(classes.has('osd-annotation--fade-out'), false);
	});
}
