// The easing names, and the guard that reads one out of a stored document — kept in their
// own module, with no imports, because the MAIN PROCESS reaches them.
//
// `parse.ts` validates the name on every load, and the main process bundles `parse.ts`. If
// these lived beside the curves in `easing.ts`, that module's import of `zoomMath/mathUtils`
// would ride into the main bundle — and `mathUtils` imports through the renderer's `@` alias,
// which the Electron build does not define. The result was a main bundle that failed to
// build while the renderer built fine, so the app silently kept running an older main
// process that did not know the new document field and stripped it on load.

/**
 * The curves the Inspector offers. Deliberately NOT including `screenStudio`: that is the
 * curve the legacy Full Camera envelope was drawn with, kept in the model so an upgraded
 * project animates frame-for-frame the way it did before, and reachable only by the adapter
 * that produces it.
 */
export const CAMERA_MOTION_EASINGS = ["linear", "quadratic", "cubic", "quintic", "spring"] as const;

export type CameraMotionEasing = (typeof CAMERA_MOTION_EASINGS)[number];

/** Every curve a stored region may name, offered or not. */
export const ALL_CAMERA_MOTION_EASINGS = [...CAMERA_MOTION_EASINGS, "screenStudio"] as const;

export type AnyCameraMotionEasing = (typeof ALL_CAMERA_MOTION_EASINGS)[number];

export function isCameraMotionEasing(value: unknown): value is AnyCameraMotionEasing {
	return (
		typeof value === "string" && (ALL_CAMERA_MOTION_EASINGS as readonly string[]).includes(value)
	);
}
