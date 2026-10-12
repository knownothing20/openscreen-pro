import type { FocusEffect, ScreenMotionTarget } from "./resolve";

/**
 * What a new screen move starts from: the card where it already sits, a touch larger.
 *
 * Unlike the camera's default this is NOT a preset the app depends on — a screen move
 * authored from the toolbar starts here and the Inspector takes over. It is deliberately
 * close to the base state so the first thing a user sees is the screen breathing rather
 * than jumping somewhere it has never been.
 */
export const SCREEN_MOTION_DEFAULT_TARGET: ScreenMotionTarget = {
	position: { x: 0.5, y: 0.5 },
	scale: 1.1,
	rotationX: 0,
	rotationY: 0,
	rotationZ: 0,
	perspective: 0.65,
};

/**
 * The timing a newly created region starts with. Same numbers as the camera's, so a screen
 * move and a camera move created back to back arrive on the same rhythm.
 */
export const DEFAULT_SCREEN_MOTION_TIMING = {
	leadInSec: 0.6,
	returnSec: 0.9,
	easing: "cubic",
} as const;

/**
 * The ranges a stored region is clamped into. Shared by the schema and the Inspector, so a
 * value the UI can produce is a value the document accepts and a hand-edited file cannot
 * put the compositor somewhere it has no geometry for.
 *
 * `scale` floors above zero for the same reason the camera's `size` does: a screen scaled
 * to nothing is not a preference, it is the picture that vanished. The rotations are
 * bounded because a full turn is not a move — it is a spin, and the quad renderer's
 * perspective has no meaningful answer at 180 degrees.
 */
export const SCREEN_MOTION_LIMITS = {
	positionMin: 0,
	positionMax: 1,
	scaleMin: 0.05,
	scaleMax: 4,
	rotationMin: -90,
	rotationMax: 90,
	perspectiveMin: 0,
	perspectiveMax: 2,
	/** Same 5s ceiling DogSC's `TransitionTiming` clamps to. The half-duration clamp that
	 *  actually bounds the windows happens at evaluation time. */
	timingSecMin: 0,
	timingSecMax: 5,
} as const;

/**
 * The focus effect a screen move starts with, when one is created with the effect already
 * on it: a round pool, following the move, at DogSC's own starting numbers.
 *
 * `dimming` is non-zero on purpose — the point of shipping the feature is that the first
 * one a user adds does something visible, and a spotlight at zero dimming is a control with
 * nothing behind it.
 */
export const FOCUS_EFFECT_DEFAULT: FocusEffect = {
	shape: "radial",
	angleDegrees: 0,
	target: "animation",
	center: { x: 0.5, y: 0.5 },
	size: 0.45,
	softness: 0.5,
	dimming: 0.18,
};

/**
 * The ranges a stored focus effect is clamped into. Shared by the parser and the Inspector
 * on the same terms as the motion limits above: a value the UI can produce is a value the
 * document accepts, and a hand-edited file cannot reach the renderer out of range.
 *
 * `size` floors at 0.1 rather than above zero because that is DogSC's own validity bound —
 * a pool narrower than that reads as a pixel, not as a spotlight.
 */
export const FOCUS_EFFECT_LIMITS = {
	sizeMin: 0.1,
	sizeMax: 1,
	softnessMin: 0,
	softnessMax: 1,
	dimmingMin: 0,
	dimmingMax: 1,
	angleMin: 0,
	angleMax: 360,
} as const;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** A finite number, or the fallback. Stored files are hand-editable and a NaN that reached
 *  the compositor would take the whole frame's geometry with it. */
export function finiteOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function clampScreenMotionPosition(value: unknown, fallback: number): number {
	return clamp(
		finiteOr(value, fallback),
		SCREEN_MOTION_LIMITS.positionMin,
		SCREEN_MOTION_LIMITS.positionMax,
	);
}

export function clampScreenMotionScale(value: unknown, fallback: number): number {
	return clamp(
		finiteOr(value, fallback),
		SCREEN_MOTION_LIMITS.scaleMin,
		SCREEN_MOTION_LIMITS.scaleMax,
	);
}

export function clampScreenMotionRotation(value: unknown, fallback: number): number {
	return clamp(
		finiteOr(value, fallback),
		SCREEN_MOTION_LIMITS.rotationMin,
		SCREEN_MOTION_LIMITS.rotationMax,
	);
}

export function clampScreenMotionPerspective(value: unknown, fallback: number): number {
	return clamp(
		finiteOr(value, fallback),
		SCREEN_MOTION_LIMITS.perspectiveMin,
		SCREEN_MOTION_LIMITS.perspectiveMax,
	);
}

export function clampScreenMotionTimingSec(value: unknown, fallback: number): number {
	return clamp(
		finiteOr(value, fallback),
		SCREEN_MOTION_LIMITS.timingSecMin,
		SCREEN_MOTION_LIMITS.timingSecMax,
	);
}

export function clampFocusEffectSize(value: unknown, fallback: number): number {
	return clamp(finiteOr(value, fallback), FOCUS_EFFECT_LIMITS.sizeMin, FOCUS_EFFECT_LIMITS.sizeMax);
}

export function clampFocusEffectSoftness(value: unknown, fallback: number): number {
	return clamp(
		finiteOr(value, fallback),
		FOCUS_EFFECT_LIMITS.softnessMin,
		FOCUS_EFFECT_LIMITS.softnessMax,
	);
}

export function clampFocusEffectDimming(value: unknown, fallback: number): number {
	return clamp(
		finiteOr(value, fallback),
		FOCUS_EFFECT_LIMITS.dimmingMin,
		FOCUS_EFFECT_LIMITS.dimmingMax,
	);
}

/**
 * An angle of the band, wrapped into [0, 360).
 *
 * A wrap rather than a clamp: 450 degrees and 90 degrees draw the same band, so clamping
 * would silently turn a second turn into a stopped one. Taken from DogSC's
 * `normalizedAngle`, including its handling of negatives (-90 reads as 270).
 */
export function normalizeFocusAngle(degrees: number): number {
	const wrapped = degrees % FOCUS_EFFECT_LIMITS.angleMax;
	return wrapped < 0 ? wrapped + FOCUS_EFFECT_LIMITS.angleMax : wrapped;
}

export function clampFocusEffectAngle(value: unknown, fallback: number): number {
	return normalizeFocusAngle(finiteOr(value, fallback));
}
