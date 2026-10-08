import type { CameraMotionTarget } from "./resolve";

/**
 * What "Full Camera" means, and what a legacy Full Camera region animates towards: the
 * picture covering the canvas. One definition, because the C shortcut's preset, the legacy
 * adapter and the resolver's fold-in all mean exactly this — a second copy would be a
 * second thing to keep in step.
 */
export const CAMERA_MOTION_FULLSCREEN_TARGET: CameraMotionTarget = {
	layout: "fullscreen",
	shape: "square",
	position: { x: 0.5, y: 0.5 },
	size: 1,
	roundness: 0,
	opacity: 1,
};

/** What a new region starts from: the camera where it already is, one square-ish step
 *  bigger. Only a starting point for the Inspector to edit — nothing consumes it as a
 *  semantic default. */
export const CAMERA_MOTION_DEFAULT_TARGET: CameraMotionTarget = {
	layout: "shape",
	shape: "square",
	position: { x: 0.78, y: 0.78 },
	size: 0.32,
	roundness: 0.22,
	opacity: 1,
};

/**
 * The timing a newly created region starts with: a touch under a second to arrive, a
 * little longer to come back, on the `cubic` curve. Chosen to sit near what the legacy
 * Full Camera envelope did (0.55s in, 0.825s out) so the first region a user adds feels
 * like the feature they already know.
 */
export const DEFAULT_CAMERA_MOTION_TIMING = {
	leadInSec: 0.6,
	returnSec: 0.9,
	easing: "cubic",
} as const;

/**
 * The ranges a stored region is clamped into. Shared by the schema and the Inspector so a
 * value the UI can produce is a value the document accepts, and a hand-edited file cannot
 * put the compositor somewhere it has no geometry for.
 *
 * `size` floors above zero for the same reason the marker opacity does: a camera scaled to
 * nothing is not a preference, it is a picture that vanished.
 */
export const CAMERA_MOTION_LIMITS = {
	positionMin: 0,
	positionMax: 1,
	sizeMin: 0.05,
	sizeMax: 1,
	roundnessMin: 0,
	roundnessMax: 1,
	opacityMin: 0,
	opacityMax: 1,
	/** Lead-in and return are windows inside the region, so neither may outlast it; this is
	 *  the same 5s ceiling DogSC's `TransitionTiming` clamps to. The half-duration clamp
	 *  that actually bounds them happens at evaluation time. */
	timingSecMin: 0,
	timingSecMax: 5,
} as const;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** A finite number, or the fallback. Stored files are hand-editable and a NaN that reached
 *  the compositor would take the whole frame's geometry with it. */
export function finiteOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function clampCameraMotionPosition(value: unknown, fallback: number): number {
	return clamp(
		finiteOr(value, fallback),
		CAMERA_MOTION_LIMITS.positionMin,
		CAMERA_MOTION_LIMITS.positionMax,
	);
}

export function clampCameraMotionSize(value: unknown, fallback: number): number {
	return clamp(
		finiteOr(value, fallback),
		CAMERA_MOTION_LIMITS.sizeMin,
		CAMERA_MOTION_LIMITS.sizeMax,
	);
}

export function clampCameraMotionRoundness(value: unknown, fallback: number): number {
	return clamp(
		finiteOr(value, fallback),
		CAMERA_MOTION_LIMITS.roundnessMin,
		CAMERA_MOTION_LIMITS.roundnessMax,
	);
}

export function clampCameraMotionOpacity(value: unknown, fallback: number): number {
	return clamp(
		finiteOr(value, fallback),
		CAMERA_MOTION_LIMITS.opacityMin,
		CAMERA_MOTION_LIMITS.opacityMax,
	);
}

export function clampCameraMotionTimingSec(value: unknown, fallback: number): number {
	return clamp(
		finiteOr(value, fallback),
		CAMERA_MOTION_LIMITS.timingSecMin,
		CAMERA_MOTION_LIMITS.timingSecMax,
	);
}
