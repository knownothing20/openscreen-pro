// The screen motion evaluator, before anything renders it.
//
// Two things here are load-bearing and easy to get subtly wrong:
//
//  1. Position and scale must travel together through RECT space. Interpolating them
//     independently walks the card along `position × (canvas − scaledCard)`, which grows it
//     in the middle and only then slides it. The first test below pins the rect-space
//     answer AND states what the wrong path would have produced, so a future refactor that
//     "simplifies" the lerp fails with a number rather than a shrug.
//
//  2. Nothing may ever divide by `canvas − scaledCard` on a MOVING card. DogSC records that
//     the denominator crosses zero as the card grows through canvas size, and that it cost
//     them a one-frame jump. The rect is built forward from position and scale instead.

import { describe, expect, it } from "vitest";
import { parseScreenMotionRegion, parseScreenMotionRegions } from "./parse";
import { SCREEN_MOTION_DEFAULT_TARGET } from "./presets";
import {
	lerpScreenMotionState,
	resolveScreenMotionAtTime,
	resolveScreenMotionWinner,
	type ScreenMotionRegion,
	type ScreenMotionState,
	type ScreenMotionViewport,
	screenMotionBaseState,
	screenMotionProgressAt,
	screenMotionRectAt,
} from "./resolve";

/** A 1000×1000 canvas with a 100×100 card — round numbers, so a wrong path is visible. */
const VIEWPORT: ScreenMotionViewport = {
	canvasWidth: 1000,
	canvasHeight: 1000,
	baseWidth: 100,
	baseHeight: 100,
};

/** The card flush to the top-left, at its own size. */
const BASE_RECT = { x: 0, y: 0, width: 100, height: 100 };

function region(over: Partial<ScreenMotionRegion> = {}): ScreenMotionRegion {
	return {
		id: "sm1",
		startMs: 1000,
		endMs: 5000,
		timing: { leadInSec: 0.6, returnSec: 0.9, easing: "linear" },
		target: { ...SCREEN_MOTION_DEFAULT_TARGET, position: { x: 0.5, y: 0.5 }, scale: 2 },
		...over,
	};
}

describe("screen motion envelope", () => {
	const r = region();

	it("is 0 outside the region and 1 through its hold", () => {
		expect(screenMotionProgressAt(r, 0)).toBe(0);
		expect(screenMotionProgressAt(r, 1000)).toBe(0);
		expect(screenMotionProgressAt(r, 5000)).toBe(0);
		expect(screenMotionProgressAt(r, 3000)).toBe(1);
	});

	it("reaches the target before the region ends, so the return finishes inside it", () => {
		// leadIn 0.6s from 1000 → fully there at 1600.
		expect(screenMotionProgressAt(r, 1600)).toBeCloseTo(1, 6);
		// return 0.9s before 5000 → already easing back at 4500, gone by 5000.
		expect(screenMotionProgressAt(r, 4500)).toBeGreaterThan(0);
		expect(screenMotionProgressAt(r, 4500)).toBeLessThan(1);
		expect(screenMotionProgressAt(r, 4999)).toBeLessThan(0.1);
	});
});

describe("screen motion interpolation", () => {
	it("keeps the card on the straight line between the two rects, not the bilinear path", () => {
		const from = screenMotionBaseState(BASE_RECT, VIEWPORT);
		const to: ScreenMotionState = {
			position: { x: 0.5, y: 0.5 },
			scale: 2,
			rotationX: 0,
			rotationY: 0,
			rotationZ: 0,
			perspective: 0,
		};

		const middle = lerpScreenMotionState(from, to, 0.5, VIEWPORT);
		const rect = screenMotionRectAt(middle, VIEWPORT);

		// The two ends: left edge 0 → 400. Halfway along the straight line is 200.
		expect(rect.x).toBeCloseTo(200, 6);

		// What the INDEPENDENT lerp would have produced: position and scale each at their
		// own midpoint, then multiplied. 12.5px of drift, which is the whole point.
		const wrongScale = 1.5;
		const wrongPosition = 0.25;
		const wrongX = wrongPosition * (VIEWPORT.canvasWidth - wrongScale * VIEWPORT.baseWidth);
		expect(wrongX).toBeCloseTo(212.5, 6);
		expect(rect.x).not.toBeCloseTo(wrongX, 3);
	});

	it("scales about the anchor the authored position names", () => {
		// Centred target: the card grows around the canvas centre, so the rect stays centred.
		const from = screenMotionBaseState({ x: 450, y: 450, width: 100, height: 100 }, VIEWPORT);
		const to: ScreenMotionState = {
			position: { x: 0.5, y: 0.5 },
			scale: 2,
			rotationX: 0,
			rotationY: 0,
			rotationZ: 0,
			perspective: 0,
		};

		const atTarget = screenMotionRectAt(lerpScreenMotionState(from, to, 1, VIEWPORT), VIEWPORT);
		expect(atTarget.width).toBe(200);
		expect(atTarget.x).toBeCloseTo(400, 6);
	});

	it("blends rotations and perspective on the same clock as everything else", () => {
		const from: ScreenMotionState = {
			position: { x: 0.5, y: 0.5 },
			scale: 1,
			rotationX: 0,
			rotationY: 0,
			rotationZ: 0,
			perspective: 0.65,
		};
		const to: ScreenMotionState = {
			position: { x: 0.5, y: 0.5 },
			scale: 1,
			rotationX: 30,
			rotationY: -20,
			rotationZ: 10,
			perspective: 0.25,
		};

		const half = lerpScreenMotionState(from, to, 0.5, VIEWPORT);
		expect(half.rotationX).toBeCloseTo(15, 6);
		expect(half.rotationY).toBeCloseTo(-10, 6);
		expect(half.rotationZ).toBeCloseTo(5, 6);
		expect(half.perspective).toBeCloseTo(0.45, 6);
	});
});

describe("screen motion base state", () => {
	it("reads the placement the project already chose", () => {
		const base = screenMotionBaseState({ x: 450, y: 450, width: 100, height: 100 }, VIEWPORT);
		expect(base.position.x).toBeCloseTo(0.5, 6);
		expect(base.position.y).toBeCloseTo(0.5, 6);
		expect(base.scale).toBe(1);
	});

	it("resolves a card that fills the canvas to the centre instead of to infinity", () => {
		// The denominator is zero here. Nothing may divide by it.
		const base = screenMotionBaseState({ x: 0, y: 0, width: 1000, height: 1000 }, VIEWPORT);
		expect(base.position.x).toBe(0.5);
		expect(base.position.y).toBe(0.5);
	});
});

describe("screen motion winner", () => {
	it("returns the base rect when nothing is playing", () => {
		const sample = resolveScreenMotionAtTime({
			baseRect: BASE_RECT,
			viewport: VIEWPORT,
			regions: [region()],
			timeMs: 200,
		});
		expect(sample.rect).toEqual(BASE_RECT);
	});

	it("takes the strongest of two overlapping regions", () => {
		// Both are running at 3000, but the long one is still easing in (its lead-in is
		// clamped to half its length, so it is at 0.5 there) while the short one has arrived.
		const weak = region({
			id: "weak",
			startMs: 1000,
			endMs: 9000,
			timing: { leadInSec: 5, returnSec: 0.9, easing: "linear" },
		});
		const strong = region({
			id: "strong",
			startMs: 1000,
			endMs: 5000,
			target: { ...SCREEN_MOTION_DEFAULT_TARGET, position: { x: 1, y: 1 }, scale: 1.5 },
		});

		const winner = resolveScreenMotionWinner({
			regions: [weak, strong],
			timeMs: 3000,
		});
		expect(winner?.regionId).toBe("strong");
		expect(winner?.progress).toBeCloseTo(1, 6);
	});

	it("is null before the first region starts", () => {
		expect(resolveScreenMotionWinner({ regions: [region()], timeMs: 999 })).toBeNull();
	});
});

describe("screen motion parsing", () => {
	it("repairs an out-of-range target instead of dropping the project", () => {
		const parsed = parseScreenMotionRegion({
			id: "sm1",
			startMs: 0,
			endMs: 1000,
			timing: { leadInSec: 0.5, returnSec: 0.5, easing: "cubic" },
			target: { position: { x: 5, y: -3 }, scale: "big", rotationX: 400, perspective: -1 },
		});

		expect(parsed).not.toBeNull();
		// Clamped, not rejected — and the fallback fills what could not be read at all.
		expect(parsed?.target.position).toEqual({ x: 1, y: 0 });
		expect(parsed?.target.scale).toBe(SCREEN_MOTION_DEFAULT_TARGET.scale);
		expect(parsed?.target.rotationX).toBe(90);
		expect(parsed?.target.perspective).toBe(0);
	});

	it("drops only what cannot be a region", () => {
		expect(parseScreenMotionRegion(null)).toBeNull();
		expect(parseScreenMotionRegion({ startMs: 0, endMs: 1 })).toBeNull();
		expect(parseScreenMotionRegion({ id: "  ", startMs: 0, endMs: 1 })).toBeNull();
		expect(parseScreenMotionRegion({ id: "a", startMs: 0 })).toBeNull();
		expect(parseScreenMotionRegions("nope")).toEqual([]);
		expect(parseScreenMotionRegions([{ id: "a", startMs: 0, endMs: 1 }])).toHaveLength(1);
	});

	it("repairs a collapsed span to one millisecond rather than rejecting it", () => {
		const parsed = parseScreenMotionRegion({ id: "a", startMs: 500, endMs: 500 });
		expect(parsed).toMatchObject({ startMs: 500, endMs: 501 });
	});

	it("falls back to the default easing when the name is unknown", () => {
		const parsed = parseScreenMotionRegion({
			id: "a",
			startMs: 0,
			endMs: 1000,
			timing: { easing: "wiggle" },
		});
		expect(parsed?.timing.easing).toBe("cubic");
	});
});
