// spatial.js — the station's rooms, adjacency, and walk costs.
//
// This is a direct, literal transcription of station.md's "Adjacency list
// (engine ground truth)". The content doc's prose header says "Rooms (10)" but
// the ground-truth adjacency list names ELEVEN distinct nodes (gallery, lamp,
// watch, base, cottage, quarters, store, workshop, cellar, siren, boathouse).
// Per engine-spec ("walk costs EXACTLY per station.md's list") the list is the
// authority, so all eleven are implemented; the header/list count mismatch is
// surfaced to the author rather than resolved here.

/**
 * @typedef {import('./types.js').Weather} Weather
 */

// Room ids. Kept as an exported set so day.js / callers can validate a room id
// without duplicating the list.
export const ROOMS = Object.freeze([
	'gallery', 'lamp', 'watch', 'base', 'cottage',
	'quarters', 'store', 'workshop', 'cellar', 'siren', 'boathouse',
]);

// Undirected adjacency, transcribed verbatim from station.md. Each edge:
//   [a, b, cost, outdoor]. `outdoor` marks the yard/slipway legs that weather
//   acts on (the three outbuilding links). Indoor legs are weather-immune.
// We store edges once (undirected) and index both directions at module load, so
// there is a single source of truth for a cost — no chance of a->b and b->a
// drifting apart.
const EDGES = Object.freeze([
	['gallery', 'lamp', 1, false],
	['lamp', 'watch', 2, false],
	['watch', 'base', 2, false],
	['base', 'cottage', 1, false],
	['base', 'cellar', 1, false],
	['cottage', 'quarters', 1, false],
	['cottage', 'store', 1, false],
	['cottage', 'workshop', 1, false],
	['workshop', 'siren', 2, true],
	['workshop', 'boathouse', 3, true],
	['siren', 'boathouse', 2, true],
]);

// Adjacency index: "from|to" -> {cost, outdoor}. Built once at load (bounded by
// EDGES.length) so lookups are O(1) and the doubling/gating logic below never
// re-scans the edge list.
const ADJ = buildAdjacency(EDGES);

/**
 * buildAdjacency — expand the undirected edge list into a both-directions map.
 * Receives the EDGES array; returns a Map keyed "from|to". Internal; runs once.
 */
function buildAdjacency(edges) {
	const map = new Map();
	for (const [a, b, cost, outdoor] of edges) {
		map.set(`${a}|${b}`, { cost, outdoor });
		map.set(`${b}|${a}`, { cost, outdoor });
	}
	return map;
}

/**
 * areAdjacent — is there a single walkable leg between two rooms?
 * Receives two room ids; returns boolean. Callers (day.js move) use this to
 * offer only legal moves; walkCost itself throws on a non-edge so a bug can't
 * silently cost zero.
 */
export function areAdjacent(from, to) {
	return ADJ.has(`${from}|${to}`);
}

/**
 * neighbors — every room reachable in one leg from `room`.
 * Receives a room id; returns an array of adjacent room ids (empty if none).
 * Provided so the UI/scene can render exits without knowing the edge table.
 */
export function neighbors(room) {
	const out = [];
	for (const [key, ] of ADJ) {
		const [from, to] = key.split('|');
		if (from === room) out.push(to);
	}
	return out;
}

/**
 * walkCost — the time cost, and blocked status, of one leg in given weather.
 * Receives: from room, to room, current weather, and deliberate (the risk
 *   choice the UI surfaces for storm legs).
 * Returns: { cost, blocked }.
 *   - Indoor legs: base cost, never blocked, weather-immune.
 *   - Outdoor legs in a "blow": cost DOUBLES (station.md).
 *   - Outdoor legs in a "storm": BLOCKED unless deliberate:true is passed, which
 *     bypasses the gate at base cost.
 * Throws if the two rooms are not adjacent — that is a programming error (the
 *   caller offered an impossible move), and a loud throw beats a silent 0-cost
 *   free teleport (Power-of-Ten §5).
 *
 * SPEC NOTE (flagged to the author, not decided here): engine-spec states
 *   doubling for "blow" and a gate for "storm", but is silent on whether a storm
 *   leg ALSO doubles. This implements the literal reading — storm returns BASE
 *   cost when deliberate — so a storm leg is currently cheaper than a blow leg.
 *   If storms should be at least as costly as blows, the storm branch needs the
 *   ×2 too. Left as base pending the author's ruling.
 */
export function walkCost(from, to, weather, deliberate = false) {
	const edge = ADJ.get(`${from}|${to}`);
	if (!edge) throw new Error(`no walkable leg between "${from}" and "${to}"`);
	if (!edge.outdoor) return { cost: edge.cost, blocked: false };
	if (weather === 'storm') {
		return deliberate
			? { cost: edge.cost, blocked: false }
			: { cost: edge.cost, blocked: true };
	}
	if (weather === 'blow') return { cost: edge.cost * 2, blocked: false };
	return { cost: edge.cost, blocked: false };
}
