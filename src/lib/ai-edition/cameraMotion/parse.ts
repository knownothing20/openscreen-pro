import { isCameraMotionEasing } from "./easingNames";
import {
	CAMERA_MOTION_DEFAULT_TARGET,
	clampCameraMotionOpacity,
	clampCameraMotionPosition,
	clampCameraMotionRoundness,
	clampCameraMotionSize,
	clampCameraMotionTimingSec,
	finiteOr,
} from "./presets";
import type { CameraMotionRegion, CameraMotionTarget } from "./resolve";

/**
 * Reading a camera motion region out of a document.
 *
 * Hand-written rather than expressed as one zod object, because the requirements are about
 * REPAIR, not rejection: a project with a region whose `size` was hand-edited to `"big"`
 * must still open, with that one field put back in range, and only a region that cannot be
 * a region at all (no id, not an object) is dropped. A zod schema would either fail the
 * whole document or need a `.catch()` on every leaf, which is the same code with less
 * control over what the fallback is.
 *
 * This is the only door into the model from stored bytes, so everything downstream can
 * assume the invariants the resolver relies on.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function parseCameraMotionTarget(value: unknown): CameraMotionTarget {
	const raw = asRecord(value) ?? {};
	const fallback = CAMERA_MOTION_DEFAULT_TARGET;
	const position = asRecord(raw.position) ?? {};
	return {
		layout: raw.layout === "fullscreen" ? "fullscreen" : "shape",
		shape:
			raw.shape === "horizontal" || raw.shape === "circle" || raw.shape === "original"
				? raw.shape
				: "square",
		position: {
			x: clampCameraMotionPosition(position.x, fallback.position.x),
			y: clampCameraMotionPosition(position.y, fallback.position.y),
		},
		size: clampCameraMotionSize(raw.size, fallback.size),
		roundness: clampCameraMotionRoundness(raw.roundness, fallback.roundness),
		opacity: clampCameraMotionOpacity(raw.opacity, fallback.opacity),
	};
}

/**
 * A stored region, or null when there is not enough there to be one.
 *
 * The span is repaired rather than rejected: `endMs <= startMs` becomes a one-millisecond
 * region, which is invisible but harmless, instead of taking the project down with it.
 */
export function parseCameraMotionRegion(value: unknown): CameraMotionRegion | null {
	const raw = asRecord(value);
	if (!raw) return null;
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!id) return null;

	const startMs = finiteOr(raw.startMs, Number.NaN);
	const endMs = finiteOr(raw.endMs, Number.NaN);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

	const timing = asRecord(raw.timing) ?? {};
	const easing = isCameraMotionEasing(timing.easing) ? timing.easing : "cubic";

	return {
		id,
		startMs,
		endMs: endMs > startMs ? endMs : startMs + 1,
		timing: {
			leadInSec: clampCameraMotionTimingSec(timing.leadInSec, 0.6),
			returnSec: clampCameraMotionTimingSec(timing.returnSec, 0.9),
			easing,
		},
		target: parseCameraMotionTarget(raw.target),
	};
}

export function parseCameraMotionRegions(value: unknown): CameraMotionRegion[] {
	if (!Array.isArray(value)) return [];
	const regions: CameraMotionRegion[] = [];
	for (const item of value) {
		const region = parseCameraMotionRegion(item);
		if (region) regions.push(region);
	}
	return regions;
}
