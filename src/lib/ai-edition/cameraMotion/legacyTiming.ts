import type { CameraFullscreenRegion } from "@/components/video-editor/types";
import { TRANSITION_WINDOW_MS } from "../../zoomMath/constants";
import { CAMERA_MOTION_FULLSCREEN_TARGET } from "./presets";
import type { CameraMotionRegion, CameraMotionRegionTiming } from "./resolve";

/**
 * The return to the normal layout should feel gentler than the expansion, so the lead-out
 * window is stretched relative to the lead-in one. Same ratio the legacy envelope used —
 * read from the same constant it read from, so the two cannot drift apart.
 */
const LEAD_OUT_WINDOW_MS = TRANSITION_WINDOW_MS * 1.5;

/**
 * A legacy Full Camera region as timing a Camera Motion region can carry.
 *
 * This is the whole adapter. A legacy region animated `0 → fullscreen → 0` inside its own
 * bounds with a lead-in of `TRANSITION_WINDOW_MS` and a lead-out 1.5× that, both clamped to
 * half the region, drawn with `easeOutScreenStudio`. Expressed as timing, that is exactly
 * what these three numbers say, so the shared envelope draws the identical curve — the
 * compatibility is arithmetic, not a second animation path that has to be kept in step.
 *
 * The half-duration clamp is applied at evaluation time rather than here, so a region that
 * is later resized gets the clamp it would have had, not the one frozen at upgrade.
 */
export function cameraMotionLegacyEquivalentTiming(
	_region: CameraFullscreenRegion,
): CameraMotionRegionTiming {
	return {
		leadInSec: TRANSITION_WINDOW_MS / 1000,
		returnSec: LEAD_OUT_WINDOW_MS / 1000,
		easing: "screenStudio",
	};
}

/**
 * The legacy regions as Camera Motion regions, for consumers that would rather see one list
 * than two.
 *
 * They are NOT written back to the document: an old project keeps its own bytes until the
 * user edits one of these regions on purpose. This exists so the resolver, and anything
 * that needs to reason about "what camera moves does this project have", can read one shape.
 */
export function legacyFullscreenToCameraMotion(
	legacy: readonly CameraFullscreenRegion[],
): CameraMotionRegion[] {
	return legacy.map((region) => ({
		id: region.id,
		startMs: region.startMs,
		endMs: region.endMs,
		timing: cameraMotionLegacyEquivalentTiming(region),
		target: CAMERA_MOTION_FULLSCREEN_TARGET,
		// Marked so the editor can tell an upgraded legacy region from an authored one
		// without having to remember which ids came from the legacy list.
		legacyFullscreen: true,
	}));
}
