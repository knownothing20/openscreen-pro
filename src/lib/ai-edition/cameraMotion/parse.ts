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
/**
 * The v5 clip anchor, or nothing.
 *
 * Read straight off the stored region and handed back only when it is USABLE: a `clipId`
 * that is a non-empty string, and source bounds that are finite and non-negative. Anything
 * else is dropped rather than repaired — a half-anchor (a `clipId` with no bounds, a bound
 * that is a string) describes a position nothing can resolve, and inventing the missing
 * half would silently re-home the move onto whatever clip the numbers happened to land on.
 *
 * `undefined` is the answer for "the author did not give us one", which is exactly what a
 * document written before the anchor existed carries. The schema leaves all three optional
 * for that reason, so a region without them stays valid on `startMs`/`endMs` alone.
 */
export function readClipAnchor(raw: Record<string, unknown>): {
	clipId?: string;
	sourceStartSec?: number;
	sourceEndSec?: number;
} {
	const clipId =
		typeof raw.clipId === "string" && raw.clipId.trim().length > 0 ? raw.clipId.trim() : undefined;
	const bound = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
	const sourceStartSec = bound(raw.sourceStartSec);
	const sourceEndSec = bound(raw.sourceEndSec);
	// A `clipId` on its own addresses nothing, and bounds on their own say which seconds of
	// which clip — so all three travel together or none does.
	if (clipId === undefined || sourceStartSec === undefined || sourceEndSec === undefined) return {};
	return { clipId, sourceStartSec, sourceEndSec };
}

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
		// Carried through, not dropped: the anchor is the source of truth for which clip the
		// move belongs to, so losing it here would make a save→reopen forget the region's
		// media, and a later clip reorder would leave the move pointing at whatever now sits
		// under its derived `startMs`.
		...readClipAnchor(raw),
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
