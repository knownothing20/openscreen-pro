// Opening Motion — the GLOBAL entrance of the whole programme.
//
// This is the TS half of the contract the native side reads (`SceneOpening` in
// `crates/compositor/src/scene.rs`). Both halves must agree on the field names, the defaults
// and what counts as a repairable value, so the parser here and `OpeningSequence::repaired`
// there are deliberately written to the same rules — a document that survives one must
// survive the other.
//
// # Why global, and not a region
//
// The opening plays on the OUTPUT clock (`programme_time`), continuous across cuts. It is not
// anchored to a clip: a project cut into two clips at the 1 s mark plays the opening's second
// half in the second clip, not a fresh opening. That is also why it carries no clip anchor —
// see the round's notes on keeping global settings independent of the per-clip motion regions.

/** The only preset this round ships. A name we do not know falls back to it. */
export const OPENING_PRESET_SIDE_SLIDE = "sideSlide";

/** The only curve this round ships: `1 - (1 - p)^4`, an ease-out quart. */
export const OPENING_CURVE_SWIFT = "swift";

export const OPENING_ELEMENT_SCREEN = "screen";
export const OPENING_ELEMENT_CAMERA = "camera";

export const DEFAULT_OPENING_DURATION_SEC = 2.2;
export const DEFAULT_OPENING_STAGGER_SEC = 0.16;

/** Bounds the sliders and the repair share, so neither can drift from the other. */
export const MIN_OPENING_DURATION_SEC = 0.4;
export const MAX_OPENING_DURATION_SEC = 8;
export const MIN_OPENING_STAGGER_SEC = 0;
export const MAX_OPENING_STAGGER_SEC = 1.2;

/**
 * The stagger may not eat the whole duration: past this fraction the second element would
 * have no time left to enter, and "nothing moves after `duration`" would stop being true.
 * Same constant as `STAGGER_DURATION_FRACTION` in `opening.rs`.
 */
export const OPENING_STAGGER_DURATION_FRACTION = 0.8;

/** Elements this preset knows how to animate. Anything else in a stored list is dropped. */
export const OPENING_KNOWN_ELEMENTS: readonly string[] = [
	OPENING_ELEMENT_SCREEN,
	OPENING_ELEMENT_CAMERA,
];

export type OpeningElement = typeof OPENING_ELEMENT_SCREEN | typeof OPENING_ELEMENT_CAMERA;

/**
 * A stored opening. Every field is always present after parsing — a half-written object is
 * repaired rather than rejected, because a bad opening setting must never stop a project from
 * opening at all.
 */
export interface OpeningSequence {
	enabled: boolean;
	preset: string;
	durationSec: number;
	staggerSec: number;
	curve: string;
	/** Entry order. Always names both known elements after repair. */
	elementOrder: OpeningElement[];
	/** Participating elements. May name one, both, or (degenerately) neither. */
	includedElements: OpeningElement[];
}

/** What a project with no opening reads as. Disabled, so the render is unchanged. */
export function defaultOpeningSequence(): OpeningSequence {
	return {
		enabled: false,
		preset: OPENING_PRESET_SIDE_SLIDE,
		durationSec: DEFAULT_OPENING_DURATION_SEC,
		staggerSec: DEFAULT_OPENING_STAGGER_SEC,
		curve: OPENING_CURVE_SWIFT,
		elementOrder: [OPENING_ELEMENT_SCREEN, OPENING_ELEMENT_CAMERA],
		includedElements: [OPENING_ELEMENT_SCREEN, OPENING_ELEMENT_CAMERA],
	};
}

export function isKnownOpeningElement(value: unknown): value is OpeningElement {
	return typeof value === "string" && OPENING_KNOWN_ELEMENTS.includes(value);
}

/**
 * Coerce a stored number into its bounds. A non-finite value (NaN, Infinity — both of which
 * survive JSON round-trips as `null` or a bare `NaN` literal) falls back to the default
 * rather than propagating: a NaN duration would become a NaN rect, which is a black frame.
 */
function repairSec(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

/**
 * Filter unknown names, de-duplicate, and — for the entry order — fill in the elements that
 * are missing.
 *
 * `fillMissing` is what separates the two lists: the ORDER has to rank both elements or the
 * second one has no rank, while the SELECTION may legitimately name only one (that is the
 * normal case for a project with no camera).
 */
function repairElements(value: unknown, fillMissing: boolean): OpeningElement[] {
	const out: OpeningElement[] = [];
	if (Array.isArray(value)) {
		for (const name of value) {
			if (isKnownOpeningElement(name) && !out.includes(name)) out.push(name);
		}
	}
	if (fillMissing) {
		for (const element of [OPENING_ELEMENT_SCREEN, OPENING_ELEMENT_CAMERA] as const) {
			if (!out.includes(element)) out.push(element);
		}
	}
	return out;
}

/**
 * Read an opening out of whatever was stored.
 *
 * Never throws and never returns `undefined`: an absent, malformed, or partially-written value
 * all come back as a usable `OpeningSequence`. The `enabled` flag is read strictly — only a
 * literal `true` turns the opening on, so a stray string or number cannot switch it on by
 * accident — while every other field is repaired toward the default.
 */
export function parseOpeningSequence(value: unknown): OpeningSequence {
	const fallback = defaultOpeningSequence();
	if (typeof value !== "object" || value === null) return fallback;
	const raw = value as Record<string, unknown>;

	const durationSec = repairSec(
		raw.durationSec,
		DEFAULT_OPENING_DURATION_SEC,
		MIN_OPENING_DURATION_SEC,
		MAX_OPENING_DURATION_SEC,
	);
	// Bounded by the duration, exactly as the native side does. Without this a stored
	// `staggerSec: 5` on a 1 s opening would schedule the second element after the end.
	const staggerSec = Math.min(
		repairSec(
			raw.staggerSec,
			DEFAULT_OPENING_STAGGER_SEC,
			MIN_OPENING_STAGGER_SEC,
			MAX_OPENING_STAGGER_SEC,
		),
		durationSec * OPENING_STAGGER_DURATION_FRACTION,
	);

	return {
		enabled: raw.enabled === true,
		preset: typeof raw.preset === "string" && raw.preset ? raw.preset : OPENING_PRESET_SIDE_SLIDE,
		durationSec,
		staggerSec,
		curve: typeof raw.curve === "string" && raw.curve ? raw.curve : OPENING_CURVE_SWIFT,
		elementOrder: repairElements(raw.elementOrder, true),
		includedElements: repairElements(raw.includedElements, false),
	};
}

/**
 * Does this opening change anything on screen?
 *
 * Disabled, or nothing selected, both mean "identity" — and the native side short-circuits on
 * exactly the same two conditions, so a project can carry `enabled: true` with no elements
 * selected and still render bit-for-bit as if it had no opening.
 */
export function isOpeningIdentity(opening: OpeningSequence): boolean {
	return !opening.enabled || opening.includedElements.length === 0;
}

/** The stagger the sliders may offer, given a duration. Mirrors the parser's own bound. */
export function maxStaggerForDuration(durationSec: number): number {
	const bounded = repairSec(
		durationSec,
		DEFAULT_OPENING_DURATION_SEC,
		MIN_OPENING_DURATION_SEC,
		MAX_OPENING_DURATION_SEC,
	);
	return Math.min(MAX_OPENING_STAGGER_SEC, bounded * OPENING_STAGGER_DURATION_FRACTION);
}
