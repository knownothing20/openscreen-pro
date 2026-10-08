import { cubicBezier, easeOutScreenStudio, easeSpring } from "../../zoomMath/mathUtils";
import type { AnyCameraMotionEasing } from "./easingNames";

export type { AnyCameraMotionEasing, CameraMotionEasing } from "./easingNames";
export {
	ALL_CAMERA_MOTION_EASINGS,
	CAMERA_MOTION_EASINGS,
	isCameraMotionEasing,
} from "./easingNames";

/**
 * The curves themselves, keyed by the names `easingNames.ts` owns.
 *
 * This module is renderer-only by construction: it pulls in `zoomMath/mathUtils`, which
 * imports through the renderer's `@` alias, and the Electron build does not define that
 * alias. Everything the MAIN PROCESS needs from the easing model — the names, and the guard
 * that validates one — lives in `easingNames.ts` for exactly that reason. Putting the guard
 * back in here is what broke the main bundle: the renderer built, the main process did not,
 * and the app kept running an older main process that stripped the new document field.
 *
 * Reuses zoom's own curves rather than defining a second set: a camera move and a zoom that
 * start on the same frame should ease identically, and the legacy Full Camera envelope
 * (`screenStudio`) has to stay bit-identical to what `cameraFullscreenUtils` drew, so it
 * calls the same function that module calls.
 *
 * The three bezier presets are the ones DogSC's `ZoomEasingPreset` uses, so a curve picked
 * in either app means the same thing.
 */
const CURVES: Record<AnyCameraMotionEasing, (t: number) => number> = {
	linear: (t) => t,
	quadratic: (t) => cubicBezier(0.45, 0, 0.55, 1, t),
	cubic: (t) => cubicBezier(0.65, 0, 0.35, 1, t),
	quintic: (t) => cubicBezier(0.82, 0, 0.18, 1, t),
	spring: easeSpring,
	screenStudio: easeOutScreenStudio,
};

export function cameraMotionEasingFn(easing: AnyCameraMotionEasing): (t: number) => number {
	return CURVES[easing];
}
