import type { CameraFullscreenRegion } from "@/components/video-editor/types";
import { type SpeedRegion, screenTimeMs } from "../timeline/speed";
import { cameraMotionEasingFn } from "./easing";
import { cameraMotionLegacyEquivalentTiming } from "./legacyTiming";
import { CAMERA_MOTION_FULLSCREEN_TARGET } from "./presets";

/**
 * The camera as a renderer wants it: every field continuous, so a shape change is a number
 * moving rather than an enum switching. Modelled on DogSC's `CameraMotionSample`, which is
 * the reason a circle can grow into a rounded rectangle and then into the full canvas
 * without a frame where something snaps.
 *
 * `position` is normalised to the canvas (0..1, the same space `WebcamAnchor` uses), `size`
 * is a fraction of the canvas, `aspectRatio` is width/height, `cornerFraction` is the corner
 * radius as a fraction of the shorter side (0 = square corners, 0.5 = fully round),
 * `fullscreenProgress` is how far the picture has travelled towards covering the canvas,
 * and `opacity` is 0..1.
 */
export interface CameraMotionSample {
	position: { x: number; y: number };
	size: number;
	aspectRatio: number;
	cornerFraction: number;
	fullscreenProgress: number;
	opacity: number;
}

/** What a region authors. Discrete here — the author picks a shape or fullscreen — and
 *  turned into a `CameraMotionSample` by `resolveCameraMotionTarget`. */
export interface CameraMotionTarget {
	layout: "shape" | "fullscreen";
	shape: "square" | "horizontal" | "circle" | "original";
	position: { x: number; y: number };
	size: number;
	roundness: number;
	opacity: number;
}

export interface CameraMotionAspects {
	/** The camera's own picture, from the recorded track. */
	cameraAspectRatio: number;
	/** The canvas the camera is composited into. */
	canvasAspectRatio: number;
}

/**
 * The authored state as continuous numbers.
 *
 * The shape mapping is the whole trick, and it is DogSC's: each discrete shape resolves to
 * an (aspect, corner) pair instead of staying an enum, so interpolating between two targets
 * is plain arithmetic. `circle` ignores `roundness` because it is already fully round;
 * `original` keeps the camera's own aspect; fullscreen takes the canvas' aspect and drops
 * the corners, and says so through `fullscreenProgress` so the renderer knows to stop
 * insetting the picture.
 */
export function resolveCameraMotionTarget(
	target: CameraMotionTarget,
	aspects: CameraMotionAspects,
): CameraMotionSample {
	const base = {
		position: { x: target.position.x, y: target.position.y },
		size: target.size,
		opacity: target.opacity,
	};
	if (target.layout === "fullscreen") {
		return {
			...base,
			size: 1,
			aspectRatio: aspects.canvasAspectRatio,
			cornerFraction: 0,
			fullscreenProgress: 1,
		};
	}
	const corner = 0.5 * target.roundness;
	switch (target.shape) {
		case "square":
			return { ...base, aspectRatio: 1, cornerFraction: corner, fullscreenProgress: 0 };
		case "horizontal":
			return { ...base, aspectRatio: 1.5, cornerFraction: corner, fullscreenProgress: 0 };
		case "circle":
			return { ...base, aspectRatio: 1, cornerFraction: 0.5, fullscreenProgress: 0 };
		case "original":
			return {
				...base,
				aspectRatio: Math.max(aspects.cameraAspectRatio, 0.01),
				cornerFraction: corner,
				fullscreenProgress: 0,
			};
	}
}

/** Linear blend. Used for every field of a sample, which is what keeps a shape change and a
 *  position change on the same clock. */
function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

export function lerpCameraMotionSample(
	from: CameraMotionSample,
	to: CameraMotionSample,
	t: number,
): CameraMotionSample {
	return {
		position: {
			x: lerp(from.position.x, to.position.x, t),
			y: lerp(from.position.y, to.position.y, t),
		},
		size: lerp(from.size, to.size, t),
		aspectRatio: lerp(from.aspectRatio, to.aspectRatio, t),
		cornerFraction: lerp(from.cornerFraction, to.cornerFraction, t),
		fullscreenProgress: lerp(from.fullscreenProgress, to.fullscreenProgress, t),
		opacity: lerp(from.opacity, to.opacity, t),
	};
}

/**
 * How far into its own motion a region is at `timeMs`: 0 at its start, 1 through its hold,
 * 0 again at its end, eased at both ends.
 *
 * Structurally the same envelope the legacy Full Camera region used — fully contained in
 * [startMs, endMs], lead-in and return windows clamped to half the region's length so a
 * short region still completes both — which is what lets a legacy region be expressed as a
 * region with `screenStudio` easing and the old window lengths and animate identically.
 * Times are screen times, like zoom's, so a speed change stretches the motion with the
 * footage instead of sliding it off the picture.
 */
export function cameraMotionProgressAt(
	region: { startMs: number; endMs: number; timing: CameraMotionRegionTiming },
	timeMs: number,
	speedRegions: readonly SpeedRegion[] = [],
): number {
	if (timeMs <= region.startMs || timeMs >= region.endMs) return 0;

	const start = screenTimeMs(speedRegions, region.startMs);
	const end = screenTimeMs(speedRegions, region.endMs);
	const t = screenTimeMs(speedRegions, timeMs);
	const halfDuration = (end - start) / 2;
	const leadIn = Math.min(region.timing.leadInSec * 1000, halfDuration);
	const leadOut = Math.min(region.timing.returnSec * 1000, halfDuration);
	const ease = cameraMotionEasingFn(region.timing.easing);

	const leadInEnd = start + leadIn;
	if (t < leadInEnd) {
		return ease(leadIn > 0 ? (t - start) / leadIn : 1);
	}

	const leadOutStart = end - leadOut;
	if (t <= leadOutStart) return 1;

	return ease(leadOut > 0 ? (end - t) / leadOut : 0);
}

/** Only the timing half of a region, so the envelope can be read without the payload. */
export interface CameraMotionRegionTiming {
	leadInSec: number;
	returnSec: number;
	easing: Parameters<typeof cameraMotionEasingFn>[0];
}

/**
 * A stored camera move.
 *
 * `startMs`/`endMs` are the same derived RAW-virtual span every other region carries, so a
 * camera move trims, reorders and ripples with its footage exactly like a zoom does.
 */
export interface CameraMotionRegion {
	id: string;
	startMs: number;
	endMs: number;
	timing: CameraMotionRegionTiming;
	target: CameraMotionTarget;
	/** True only on regions the legacy adapter produced for evaluation; never stored. */
	legacyFullscreen?: boolean;
}

/**
 * The region that owns `timeMs` and how far into its motion the instant is.
 *
 * Split out from the blended sample below because the two consumers want different things
 * from it: a renderer wants the target box plus the progress so it can ease the RECT (the
 * one lerp every renderer already shares), while anything asking "where is the camera
 * right now" wants the sample already blended. Handing the renderer a blended sample and
 * then easing the rect again would apply the motion twice.
 */
export function resolveCameraMotionWinner(input: {
	regions: readonly CameraMotionRegion[];
	legacyRegions?: readonly CameraFullscreenRegion[];
	timeMs: number;
	speedRegions?: readonly SpeedRegion[];
	aspects: CameraMotionAspects;
}): { progress: number; target: CameraMotionSample; regionId: string } | null {
	const speedRegions = input.speedRegions ?? [];
	let bestProgress = 0;
	let bestTarget: CameraMotionTarget | null = null;
	let bestId = "";

	const consider = (
		id: string,
		region: { startMs: number; endMs: number; timing: CameraMotionRegionTiming },
		target: CameraMotionTarget,
	) => {
		const progress = cameraMotionProgressAt(region, input.timeMs, speedRegions);
		if (progress > bestProgress) {
			bestProgress = progress;
			bestTarget = target;
			bestId = id;
		}
	};

	for (const region of input.regions) {
		consider(region.id, region, region.target);
	}
	for (const legacy of input.legacyRegions ?? []) {
		consider(
			legacy.id,
			{
				startMs: legacy.startMs,
				endMs: legacy.endMs,
				timing: cameraMotionLegacyEquivalentTiming(legacy),
			},
			CAMERA_MOTION_FULLSCREEN_TARGET,
		);
	}

	if (!bestTarget || bestProgress <= 0) return null;
	return {
		progress: bestProgress,
		target: resolveCameraMotionTarget(bestTarget, input.aspects),
		regionId: bestId,
	};
}

/**
 * The camera at `timeMs`, resolved once for both consumers.
 *
 * Preview and export both read the same winner: the scene description carries the authored
 * regions and the Rust compositor evaluates the same envelope from the same numbers, so
 * neither side can drift into "preview does one thing, export does another".
 *
 * Legacy Full Camera regions are folded in here rather than migrated into the document, so
 * opening an old project leaves its bytes alone.
 */
export function resolveCameraMotionAtTime(input: {
	base: CameraMotionSample;
	regions: readonly CameraMotionRegion[];
	legacyRegions?: readonly CameraFullscreenRegion[];
	timeMs: number;
	speedRegions?: readonly SpeedRegion[];
	aspects: CameraMotionAspects;
}): CameraMotionSample {
	const winner = resolveCameraMotionWinner(input);
	if (!winner) return input.base;
	return lerpCameraMotionSample(input.base, winner.target, winner.progress);
}
