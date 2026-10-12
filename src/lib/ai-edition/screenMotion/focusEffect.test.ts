// The focus effect evaluator, before anything renders it.
//
// The load-bearing claim is the ENVELOPE one. A spotlight that faded on its own clock would
// drift against the card it is following, and the drift would only be visible once both are
// on screen — which is exactly the kind of bug a unit test has to catch instead of an eye.
// The test that matters most below asserts the spotlight's progress is the same NUMBER
// `screenMotionProgressAt` returns, at several points through the ease-in, so a second
// envelope introduced later fails here rather than in the renderer.

import { describe, expect, it } from "vitest";
import { resolveFocusEffectAt } from "./focusEffect";
import { SCREEN_MOTION_DEFAULT_TARGET } from "./presets";
import { type FocusEffect, type ScreenMotionRegion, screenMotionProgressAt } from "./resolve";

function effect(over: Partial<FocusEffect> = {}): FocusEffect {
	return {
		shape: "radial",
		angleDegrees: 0,
		target: "animation",
		center: { x: 0.5, y: 0.5 },
		size: 0.45,
		softness: 0.5,
		dimming: 0.18,
		...over,
	};
}

function region(over: Partial<ScreenMotionRegion> = {}): ScreenMotionRegion {
	return {
		id: "sm1",
		startMs: 1000,
		endMs: 5000,
		timing: { leadInSec: 0.6, returnSec: 0.9, easing: "linear" },
		target: { ...SCREEN_MOTION_DEFAULT_TARGET, position: { x: 0.25, y: 0.75 }, scale: 2 },
		focusEffect: effect(),
		...over,
	};
}

describe("resolveFocusEffectAt", () => {
	it("returns null when the region carries no effect", () => {
		const r = region({ focusEffect: undefined });
		expect(resolveFocusEffectAt({ regions: [r], timeMs: 3000 })).toBeNull();
	});

	it("returns null when there is no region at this instant", () => {
		const r = region();
		expect(resolveFocusEffectAt({ regions: [r], timeMs: 0 })).toBeNull();
		expect(resolveFocusEffectAt({ regions: [r], timeMs: 5000 })).toBeNull();
	});

	it("returns null when the effect is dimmed to zero", () => {
		// `dimming: 0` is how a user turns the spotlight off, so it must cost the renderer
		// nothing — not a zero-progress effect it still has to branch on.
		const r = region({ focusEffect: effect({ dimming: 0 }) });
		expect(resolveFocusEffectAt({ regions: [r], timeMs: 3000 })).toBeNull();
	});

	it("reads the spotlight's centre from the move's destination when the target is animation", () => {
		const r = region();
		const sample = resolveFocusEffectAt({ regions: [r], timeMs: 3000 });
		expect(sample?.center).toEqual({ x: 0.25, y: 0.75 });
	});

	it("reads the spotlight's centre from `center` when the target is fixed", () => {
		const r = region({
			focusEffect: effect({ target: "fixed", center: { x: 0.1, y: 0.9 } }),
		});
		const sample = resolveFocusEffectAt({ regions: [r], timeMs: 3000 });
		expect(sample?.center).toEqual({ x: 0.1, y: 0.9 });
	});

	it("carries the authored effect through unchanged", () => {
		const authored = effect({ shape: "linear", angleDegrees: 45, size: 0.3, softness: 0.8 });
		const r = region({ focusEffect: authored });
		const sample = resolveFocusEffectAt({ regions: [r], timeMs: 3000 });
		expect(sample?.effect).toEqual(authored);
	});

	// The point of the module. If a future change gives the spotlight its own easing, this
	// fails with two numbers that should have been one.
	it("uses the SAME envelope as the move itself, at every instant", () => {
		const r = region();
		for (const timeMs of [1000, 1200, 1400, 1600, 2000, 3000, 4200, 4400, 4600, 4800, 4999]) {
			const sample = resolveFocusEffectAt({ regions: [r], timeMs });
			const expected = screenMotionProgressAt(r, timeMs);
			if (expected <= 0) {
				expect(sample, `t=${timeMs}`).toBeNull();
				continue;
			}
			expect(sample?.progress, `t=${timeMs}`).toBeCloseTo(expected, 10);
		}
	});

	it("follows the winner when two moves overlap", () => {
		// Strongest wins, and "strongest" means FURTHEST INTO ITS OWN MOVE — not "started
		// later". At t=3000 the earlier move is through its lead-in (progress 1) while the
		// later one is still easing in, so the earlier one owns the frame. The spotlight has
		// to change hands at the same instant the card does, which is what reading the
		// winner (rather than picking a region itself) guarantees.
		const early = region({
			id: "early",
			startMs: 0,
			endMs: 4000,
			target: { ...SCREEN_MOTION_DEFAULT_TARGET, position: { x: 1, y: 1 } },
			focusEffect: effect({ dimming: 0.1 }),
		});
		const late = region({
			id: "late",
			startMs: 2000,
			endMs: 6000,
			target: { ...SCREEN_MOTION_DEFAULT_TARGET, position: { x: 0, y: 0 } },
			focusEffect: effect({ dimming: 0.9 }),
		});

		const during = resolveFocusEffectAt({ regions: [early, late], timeMs: 3000 });
		expect(during?.effect.dimming).toBe(0.1);
		expect(during?.center).toEqual({ x: 1, y: 1 });

		// Once the early move is over, the late one owns the frame — and its own centre.
		const after = resolveFocusEffectAt({ regions: [early, late], timeMs: 4500 });
		expect(after?.effect.dimming).toBe(0.9);
		expect(after?.center).toEqual({ x: 0, y: 0 });
	});

	it("stretches with the footage when a speed region overlaps", () => {
		// Screen time, like the move's own envelope: a speed change must not slide the
		// spotlight off the card it is following.
		const r = region();
		const speedRegions = [{ id: "sp1", startMs: 0, endMs: 2000, speed: 2 }];
		const slowed = resolveFocusEffectAt({ regions: [r], timeMs: 1400, speedRegions });
		const plain = resolveFocusEffectAt({ regions: [r], timeMs: 1400 });
		expect(plain).not.toBeNull();
		// The speed region compresses screen time, so at the same wall clock the move is
		// further along than it would be without one.
		expect(slowed?.progress).not.toBeCloseTo(plain?.progress ?? -1, 6);
	});
});
