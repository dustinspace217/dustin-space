// main.js — boot: wire the book, the drawing, and the game together.
//
// P4a mounted the reading experience (cover, strata, index, hands). P4c adds
// the game layer alongside — NOT inside — the book: the book stays a dumb
// page-turner; game.js drives engine state and appends live pages to it, mounts
// the action panel under the drawing, and runs the writing desk over the book
// panel. The wiring order matters only in that book + scene must exist before
// the game references them.

import { createBook } from './book.js';
import { mountScene } from './scene.js';
import { mountAudio } from './audio.js';
import { createGame } from './game.js';

// The book controller: page-turn navigation over the founding strata, plus the
// P4c appendPage hook the game uses to add player/NPC term pages.
const book = createBook({
	pageEl: document.getElementById('page'),
	prevBtn: document.getElementById('prevpage'),
	nextBtn: document.getElementById('nextpage'),
	indexBtn: document.getElementById('indexbtn'),
});

// The living cutaway: returns the { setWeather, setLamp, setFlue, setKeeper }
// surface the game drives on every state change.
const scene = mountScene(document.getElementById('cutaway'));

// The station's air. The AudioContext can only start from a user gesture, so
// the first click anywhere wakes it (the cover's "Open the log" included) —
// one listener, once, then gone.
const audio = mountAudio();
document.addEventListener('click', () => audio.enable(), { once: true });

// SOUND AND LIGHT SHARE A DRIVER: the game and the finale both talk to the
// scene api, so a thin proxy lets every setWeather/setLamp call drive the
// audio too — wind follows weather, the clockwork runs only while the lamp
// burns — without game.js or finaleview.js learning audio exists. (Why a
// proxy over editing game.js: one integration point instead of five call
// sites, and the pairing rule — light implies clockwork — lives in exactly
// one place.)
const sceneWithAir = {
	...scene,
	setWeather(w) { scene.setWeather(w); audio.setWeather(w); },
	setLamp(lit) { scene.setLamp(lit); audio.setLamp(lit); },
};

// The one listener control: a small toggle in the page nav. Muting is a
// listener preference, not a game state — it never persists or signifies.
const soundBtn = document.getElementById('soundtoggle');
soundBtn.addEventListener('click', () => {
	audio.enable(); // covers the edge where this IS the first gesture
	const muted = audio.toggleMuted();
	soundBtn.textContent = muted ? 'Sound: off' : 'Sound: on';
});

// The motion pause (QA-2026-07-24 A11Y-8): a listener control beside sound that
// stills the cutaway's beam/sea/rain/smoke and the page-turn animation via a root
// data attribute — style.css keys the still states on html[data-motion="off"].
// It REFLECTS the OS prefers-reduced-motion as its initial state and can only ADD
// stilling; it never forces motion on for someone whose OS asked to reduce it
// (the media-query stills still apply regardless of the toggle).
const motionBtn = document.getElementById('motiontoggle');
let motionOff = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function applyMotion() {
	document.documentElement.dataset.motion = motionOff ? 'off' : 'on';
	motionBtn.textContent = motionOff ? 'Motion: off' : 'Motion: on';
}
applyMotion();
motionBtn.addEventListener('click', () => { motionOff = !motionOff; applyMotion(); });

// The game session controller. It owns engine state and the flow; it renders
// into the day bar, the action panel, and the desk overlay, and reads/writes
// the book through the controller above. boot() wires the cover buttons.
const game = createGame({
	book,
	scene: sceneWithAir,
	els: {
		page: document.getElementById('page'),
		daybar: document.getElementById('daybar'),
		actions: document.getElementById('actions'),
		desk: document.getElementById('desk'),
		// QA-2026-07-24 (CR-1/A11Y-4): the two background regions game.js marks
		// `inert` while an overlay is up — #station (the whole left column) and
		// #pagenav (the book's controls). #page is already passed above.
		station: document.getElementById('station'),
		pagenav: document.getElementById('pagenav'),
	},
});
game.boot();
