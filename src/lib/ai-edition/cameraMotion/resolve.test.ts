// The camera motion model, pinned where it matters: the envelope a legacy Full Camera
// region animates on has to be the SAME curve the old code drew, frame for frame, or
// upgrading would quietly re-time every existing project's full-camera moments.

import { describe, expect, it } from "vitest";
import { computeCameraFullscreenRect } from "@/lib/compositeLayout";
import { computeCameraFullscreenProgress } from "@/lib/zoomMath/cameraFullscreenUtils";
import { CAMERA_MOTION_EASINGS, cameraMotionEasingFn } from "./easing";
import { cameraMotionLegacyEquivalentTiming, legacyFullscreenToCameraMotion } from "./legacyTiming";
import {
	CAMERA_MOTION_DEFAULT_TARGET,
	CAMERA_MOTION_FULLSCREEN_TARGET,
	clampCameraMotionOpacity,
	clampCameraMotionPosition,
	clampCameraMotionRoundness,
	clampCameraMotionSize,
	clampCameraMotionTimingSec,
} from "./presets";
import { applyCameraMotionToRect } from "./rect";
import {
	type CameraMotionRegion,
	type CameraMotionSample,
	cameraMotionProgressAt,
	lerpCameraMotionSample,
	resolveCameraMotionAtTime,
	resolveCameraMotionTarget,
} from "./resolve";

const ASPECTS = { cameraAspectRatio: 4 / 3, canvasAspectRatio: 16 / 9 };

/** A camera sitting in the corner, the way it does before any motion region runs. */
const BASE: CameraMotionSample = {
	position: { x: 0.78, y: 0.78 },
	size: 0.32,
	aspectRatio: 1,
	cornerFraction: 0.11,
	fullscreenProgress: 0,
	opacity: 1,
};

function region(overrides: Partial<CameraMotionRegion> = {}): CameraMotionRegion {
	return {
		id: "cammotion_a",
		startMs: 5_000,
		endMs: 15_000,
		timing: { leadInSec: 0.6, returnSec: 0.9, easing: "cubic" },
		target: CAMERA_MOTION_DEFAULT_TARGET,
		...overrides,
	};
}

describe("resolveCameraMotionTarget", () => {
	it("gives each shape an aspect and a corner instead of leaving an enum to switch on", () => {
		const square = resolveCameraMotionTarget(
			{ ...CAMERA_MOTION_DEFAULT_TARGET, shape: "square", roundness: 0.4 },
			ASPECTS,
		);
		expect(square.aspectRatio).toBe(1);
		expect(square.cornerFraction).toBeCloseTo(0.2, 12);

		const horizontal = resolveCameraMotionTarget(
			{ ...CAMERA_MOTION_DEFAULT_TARGET, shape: "horizontal", roundness: 0.4 },
			ASPECTS,
		);
		expect(horizontal.aspectRatio).toBe(1.5);
		expect(horizontal.cornerFraction).toBeCloseTo(0.2, 12);

		const original = resolveCameraMotionTarget(
			{ ...CAMERA_MOTION_DEFAULT_TARGET, shape: "original", roundness: 0.4 },
			ASPECTS,
		);
		expect(original.aspectRatio).toBeCloseTo(4 / 3, 12);
		expect(original.cornerFraction).toBeCloseTo(0.2, 12);
	});

	it("rounds a circle regardless of roundness, because it is already round", () => {
		const circle = resolveCameraMotionTarget(
			{ ...CAMERA_MOTION_DEFAULT_TARGET, shape: "circle", roundness: 0 },
			ASPECTS,
		);
		expect(circle.aspectRatio).toBe(1);
		expect(circle.cornerFraction).toBe(0.5);
	});

	it("takes the canvas' aspect, drops the corners and reports full progress for fullscreen", () => {
		const full = resolveCameraMotionTarget(CAMERA_MOTION_FULLSCREEN_TARGET, ASPECTS);
		expect(full.aspectRatio).toBeCloseTo(16 / 9, 12);
		expect(full.cornerFraction).toBe(0);
		expect(full.fullscreenProgress).toBe(1);
		expect(full.size).toBe(1);
	});
});

describe("cameraMotionProgressAt", () => {
	it("is zero outside the region and eases up, holds, then eases back inside it", () => {
		const r = region();
		expect(cameraMotionProgressAt(r, 0, [])).toBe(0);
		expect(cameraMotionProgressAt(r, 4_999, [])).toBe(0);
		expect(cameraMotionProgressAt(r, 15_000, [])).toBe(0);
		expect(cameraMotionProgressAt(r, 20_000, [])).toBe(0);

		// Inside the hold the picture is exactly where the region put it.
		expect(cameraMotionProgressAt(r, 10_000, [])).toBe(1);
		// Mid lead-in it is somewhere in between, and rising.
		const early = cameraMotionProgressAt(r, 5_300, []);
		const later = cameraMotionProgressAt(r, 5_450, []);
		expect(early).toBeGreaterThan(0);
		expect(later).toBeGreaterThan(early);
		expect(later).toBeLessThanOrEqual(1);
	});

	it("returns to base exactly at the end, so an adjacent region starts from the same state", () => {
		const first = region({ id: "a", startMs: 0, endMs: 10_000 });
		const second = region({ id: "b", startMs: 10_000, endMs: 20_000 });
		expect(cameraMotionProgressAt(first, 9_999, [])).toBeGreaterThan(0);
		expect(cameraMotionProgressAt(first, 10_000, [])).toBe(0);
		expect(cameraMotionProgressAt(second, 10_000, [])).toBe(0);
	});

	it("clamps both windows to half the region, so a short region still completes", () => {
		// 1s region, lead-in 0.6s and return 0.9s both exceed half of it.
		const short = region({ startMs: 0, endMs: 1_000 });
		expect(cameraMotionProgressAt(short, 499, [])).toBeGreaterThan(0);
		expect(cameraMotionProgressAt(short, 501, [])).toBeLessThan(1);
	});
});

describe("easing curves", () => {
	it("starts at 0 and lands exactly on 1, so a move neither jumps nor stops short", () => {
		for (const easing of [...CAMERA_MOTION_EASINGS, "screenStudio"] as const) {
			const ease = cameraMotionEasingFn(easing);
			expect(ease(0), easing).toBeCloseTo(0, 6);
			expect(ease(1), easing).toBeCloseTo(1, 6);
		}
	});

	it("never goes backwards on the way there", () => {
		for (const easing of [...CAMERA_MOTION_EASINGS, "screenStudio"] as const) {
			const ease = cameraMotionEasingFn(easing);
			let previous = -1;
			for (let i = 0; i <= 20; i++) {
				const value = ease(i / 20);
				expect(value, `${easing} @ ${i}`).toBeGreaterThanOrEqual(previous - 1e-9);
				previous = value;
			}
		}
	});
});

describe("resolveCameraMotionAtTime", () => {
	it("returns the base camera untouched when nothing covers the instant", () => {
		const sample = resolveCameraMotionAtTime({
			base: BASE,
			regions: [region()],
			timeMs: 1_000,
			aspects: ASPECTS,
		});
		expect(sample).toEqual(BASE);
	});

	it("interpolates position towards the target", () => {
		const target = { ...CAMERA_MOTION_DEFAULT_TARGET, position: { x: 0.2, y: 0.25 } };
		const r = region({ target, timing: { leadInSec: 1, returnSec: 1, easing: "linear" } });
		// Halfway through the lead-in, halfway to the target.
		const half = resolveCameraMotionAtTime({
			base: BASE,
			regions: [r],
			timeMs: 5_500,
			aspects: ASPECTS,
		});
		expect(half.position.x).toBeCloseTo((BASE.position.x + 0.2) / 2, 6);
		expect(half.position.y).toBeCloseTo((BASE.position.y + 0.25) / 2, 6);
		// And fully arrived inside the hold.
		const held = resolveCameraMotionAtTime({
			base: BASE,
			regions: [r],
			timeMs: 10_000,
			aspects: ASPECTS,
		});
		expect(held.position.x).toBeCloseTo(0.2, 6);
	});

	it("interpolates size, opacity and roundness on the same clock", () => {
		const r = region({
			target: {
				...CAMERA_MOTION_DEFAULT_TARGET,
				size: 0.8,
				opacity: 0.4,
				roundness: 0.8,
				shape: "square",
			},
			timing: { leadInSec: 1, returnSec: 1, easing: "linear" },
		});
		const held = resolveCameraMotionAtTime({
			base: BASE,
			regions: [r],
			timeMs: 10_000,
			aspects: ASPECTS,
		});
		expect(held.size).toBeCloseTo(0.8, 6);
		expect(held.opacity).toBeCloseTo(0.4, 6);
		expect(held.cornerFraction).toBeCloseTo(0.4, 6);

		const half = resolveCameraMotionAtTime({
			base: BASE,
			regions: [r],
			timeMs: 5_500,
			aspects: ASPECTS,
		});
		expect(half.size).toBeCloseTo((BASE.size + 0.8) / 2, 6);
		expect(half.opacity).toBeCloseTo((BASE.opacity + 0.4) / 2, 6);
	});

	it("moves PiP to fullscreen and back, continuously", () => {
		const r = region({
			target: CAMERA_MOTION_FULLSCREEN_TARGET,
			timing: { leadInSec: 1, returnSec: 1, easing: "linear" },
		});
		const at = (timeMs: number) =>
			resolveCameraMotionAtTime({ base: BASE, regions: [r], timeMs, aspects: ASPECTS });

		expect(at(5_000).fullscreenProgress).toBe(0);
		expect(at(6_000).fullscreenProgress).toBeCloseTo(1, 6);
		expect(at(10_000).fullscreenProgress).toBeCloseTo(1, 6);
		// On the way back out, half a second before the end of the return window.
		expect(at(14_500).fullscreenProgress).toBeCloseTo(0.5, 6);
		expect(at(15_000).fullscreenProgress).toBe(0);

		// No frame where the picture jumps: every step is small.
		let previous = at(5_000);
		for (let t = 5_000; t <= 15_000; t += 50) {
			const current = at(t);
			expect(Math.abs(current.fullscreenProgress - previous.fullscreenProgress)).toBeLessThan(0.2);
			previous = current;
		}
	});

	it("runs a fullscreen region back to PiP, not the other way round", () => {
		const r = region({
			target: CAMERA_MOTION_FULLSCREEN_TARGET,
			timing: { leadInSec: 0.5, returnSec: 0.5, easing: "linear" },
		});
		// Base is already fullscreen (say, the previous region left it there is not how it
		// works — the base is the layout) and the region takes it out to the corner target.
		const corner: CameraMotionRegion = {
			...r,
			target: { ...CAMERA_MOTION_DEFAULT_TARGET, position: { x: 0.2, y: 0.2 }, size: 0.25 },
		};
		const held = resolveCameraMotionAtTime({
			base: { ...BASE, fullscreenProgress: 1, size: 1, cornerFraction: 0 },
			regions: [corner],
			timeMs: 10_000,
			aspects: ASPECTS,
		});
		expect(held.fullscreenProgress).toBe(0);
		expect(held.size).toBeCloseTo(0.25, 6);
		expect(held.position.x).toBeCloseTo(0.2, 6);
	});

	it("keeps the strongest region when two overlap", () => {
		const weak = region({ id: "weak", timing: { leadInSec: 4, returnSec: 4, easing: "linear" } });
		const strong = region({
			id: "strong",
			startMs: 5_000,
			endMs: 6_000,
			target: CAMERA_MOTION_FULLSCREEN_TARGET,
			timing: { leadInSec: 0.2, returnSec: 0.2, easing: "linear" },
		});
		const sample = resolveCameraMotionAtTime({
			base: BASE,
			regions: [weak, strong],
			timeMs: 5_500,
			aspects: ASPECTS,
		});
		// The short fullscreen region is fully arrived at this instant; the long one is not.
		expect(sample.fullscreenProgress).toBeCloseTo(1, 6);
	});
});

describe("legacy Full Camera compatibility", () => {
	const legacy = { id: "legacy_a", startMs: 4_000, endMs: 14_000 };

	it("draws the identical envelope the old progress function drew, frame by frame", () => {
		// The whole compatibility claim, as arithmetic: sample both implementations across
		// the region (and outside it) and require them to agree to the last bit.
		const timing = cameraMotionLegacyEquivalentTiming(legacy);
		for (let timeMs = 0; timeMs <= 20_000; timeMs += 10) {
			const legacyProgress = computeCameraFullscreenProgress([legacy], timeMs, []);
			const newProgress = cameraMotionProgressAt(
				{ startMs: legacy.startMs, endMs: legacy.endMs, timing },
				timeMs,
				[],
			);
			expect(newProgress, `t=${timeMs}`).toBeCloseTo(legacyProgress, 12);
		}
	});

	it("agrees on a short region too, where both windows clamp to half the length", () => {
		const short = { id: "legacy_short", startMs: 1_000, endMs: 2_000 };
		const timing = cameraMotionLegacyEquivalentTiming(short);
		for (let timeMs = 500; timeMs <= 2_500; timeMs += 10) {
			expect(
				cameraMotionProgressAt({ startMs: short.startMs, endMs: short.endMs, timing }, timeMs, []),
				`t=${timeMs}`,
			).toBeCloseTo(computeCameraFullscreenProgress([short], timeMs, []), 12);
		}
	});

	it("agrees through a speed region, where both sides read screen time", () => {
		const speedRegions = [{ id: "speed_a", startMs: 0, endMs: 20_000, speed: 2 }];
		const timing = cameraMotionLegacyEquivalentTiming(legacy);
		for (let timeMs = 0; timeMs <= 20_000; timeMs += 10) {
			expect(
				cameraMotionProgressAt(
					{ startMs: legacy.startMs, endMs: legacy.endMs, timing },
					timeMs,
					speedRegions,
				),
				`t=${timeMs}`,
			).toBeCloseTo(computeCameraFullscreenProgress([legacy], timeMs, speedRegions), 12);
		}
	});

	it("resolves a legacy region to the same camera the old blend produced", () => {
		// Old path: blend base → canvas-filling rect by progress. New path: blend base →
		// resolved fullscreen target by the same progress. Same progress, same endpoints.
		const at = 9_000;
		const progress = computeCameraFullscreenProgress([legacy], at, []);
		const sample = resolveCameraMotionAtTime({
			base: BASE,
			regions: [],
			legacyRegions: [legacy],
			timeMs: at,
			aspects: ASPECTS,
		});
		const expected = lerpCameraMotionSample(
			BASE,
			resolveCameraMotionTarget(CAMERA_MOTION_FULLSCREEN_TARGET, ASPECTS),
			progress,
		);
		expect(sample).toEqual(expected);
	});

	it("exposes legacy regions as motion regions without touching their timing", () => {
		const [converted] = legacyFullscreenToCameraMotion([legacy]);
		expect(converted.id).toBe("legacy_a");
		expect(converted.startMs).toBe(4_000);
		expect(converted.endMs).toBe(14_000);
		expect(converted.legacyFullscreen).toBe(true);
		expect(converted.target).toEqual(CAMERA_MOTION_FULLSCREEN_TARGET);
	});
});

describe("limits", () => {
	it("clamps what the compositor could not draw", () => {
		expect(clampCameraMotionPosition(-1, 0.5)).toBe(0);
		expect(clampCameraMotionPosition(4, 0.5)).toBe(1);
		expect(clampCameraMotionSize(0, 0.5)).toBeGreaterThan(0);
		expect(clampCameraMotionSize(9, 0.5)).toBe(1);
		expect(clampCameraMotionRoundness(-2, 0.5)).toBe(0);
		expect(clampCameraMotionOpacity(3, 1)).toBe(1);
		expect(clampCameraMotionTimingSec(-1, 0.5)).toBe(0);
		expect(clampCameraMotionTimingSec(99, 0.5)).toBe(5);
	});

	it("answers a non-finite value with the fallback rather than letting NaN through", () => {
		expect(clampCameraMotionSize(Number.NaN, 0.32)).toBe(0.32);
		expect(clampCameraMotionOpacity("0.5", 1)).toBe(1);
		expect(clampCameraMotionPosition(Number.POSITIVE_INFINITY, 0.5)).toBe(0.5);
	});
});

describe("applyCameraMotionToRect", () => {
	const base = {
		x: 100,
		y: 200,
		width: 300,
		height: 225,
		borderRadius: 24,
		maskShape: "rectangle" as const,
	};
	const canvas = { width: 1920, height: 1080 };

	it("IS the legacy fullscreen rect function when the target is fullscreen", () => {
		// Not "close to": the same endpoints and the same lerp, so the rect every renderer
		// is handed during an upgraded project's Full Camera moment is unchanged.
		const target = resolveCameraMotionTarget(CAMERA_MOTION_FULLSCREEN_TARGET, ASPECTS);
		for (let progress = 0; progress <= 1.0001; progress += 0.05) {
			expect(applyCameraMotionToRect(base, target, progress, canvas), `p=${progress}`).toEqual(
				computeCameraFullscreenRect(base, canvas, progress),
			);
		}
	});

	it("places the box the sample describes, centred on its position", () => {
		const target = resolveCameraMotionTarget(
			{
				...CAMERA_MOTION_DEFAULT_TARGET,
				position: { x: 0.25, y: 0.5 },
				size: 0.5,
				shape: "square",
				roundness: 0.4,
			},
			ASPECTS,
		);
		const rect = applyCameraMotionToRect(base, target, 1, canvas);
		expect(rect.width).toBeCloseTo(960, 6);
		expect(rect.height).toBeCloseTo(960, 6);
		expect(rect.x + rect.width / 2).toBeCloseTo(0.25 * canvas.width, 6);
		expect(rect.y + rect.height / 2).toBeCloseTo(0.5 * canvas.height, 6);
		// roundness 0.4 → corner fraction 0.2 → radius is a fifth of the shorter side.
		expect(rect.borderRadius).toBeCloseTo(0.2 * 960, 6);
	});
});
