import type { Size, StyledRenderRect } from "@/lib/compositeLayout";

/**
 * Turning a resolved camera sample into the box the renderer draws.
 *
 * This is where the unified model meets the geometry, and the reason it is a separate
 * module: `computeCameraFullscreenRect` already lerps the base rect towards the canvas
 * rect, and every renderer — preview, both exporters, the native compositor — calls it.
 * Generalising "towards the canvas" into "towards whatever the motion sample describes"
 * keeps that one lerp, so a legacy Full Camera region is not a special case with its own
 * arithmetic: it is this function with the fullscreen sample, and the two are bit-identical.
 *
 * The mask shape is always flattened to a rectangle for the same reason the legacy path
 * did it: the roundness is carried in `borderRadius`, which lerps, so a circle easing into
 * a full-bleed rectangle is one continuous number rather than a shape switch.
 */

function lerp(from: number, to: number, t: number): number {
	return from + (to - from) * t;
}

/**
 * The box a sample describes, in canvas pixels.
 *
 * `position` is the CENTRE of the camera picture, `size` its width as a fraction of the
 * canvas, and `aspectRatio` gives the height — so a sample says where the camera is and how
 * big, without carrying a corner.
 */
export function cameraMotionTargetRect(
	sample: CameraMotionSampleLike,
	canvasSize: Size,
): StyledRenderRect {
	const width = sample.size * canvasSize.width;
	const height = width / Math.max(sample.aspectRatio, 0.01);
	return {
		x: sample.position.x * canvasSize.width - width / 2,
		y: sample.position.y * canvasSize.height - height / 2,
		width,
		height,
		// Corner radius as a fraction of the shorter side, the same reading DogSC's
		// `cornerFraction` has: 0.5 on a square box IS a circle.
		borderRadius: sample.cornerFraction * Math.min(width, height),
		maskShape: "rectangle",
	};
}

/** Just enough of a sample to place a box, so this module does not depend on the resolver. */
export interface CameraMotionSampleLike {
	position: { x: number; y: number };
	size: number;
	aspectRatio: number;
	cornerFraction: number;
}

/**
 * The base rect eased towards the box the target sample describes.
 *
 * With the fullscreen target this returns exactly what `computeCameraFullscreenRect`
 * returns for the same progress — same endpoints (the canvas, radius 0) and the same lerp —
 * which is what keeps an upgraded project's Full Camera animation untouched.
 */
export function applyCameraMotionToRect(
	base: StyledRenderRect,
	target: CameraMotionSampleLike,
	progress: number,
	canvasSize: Size,
): StyledRenderRect {
	const t = Math.max(0, Math.min(1, progress));
	const destination = cameraMotionTargetRect(target, canvasSize);
	return {
		x: lerp(base.x, destination.x, t),
		y: lerp(base.y, destination.y, t),
		width: lerp(base.width, destination.width, t),
		height: lerp(base.height, destination.height, t),
		borderRadius: lerp(base.borderRadius, destination.borderRadius, t),
		maskShape: "rectangle",
	};
}
