import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { suggestSteps } from "./stepSuggestions";

const click = (timeMs: number, cx: number, cy: number): CursorTelemetryPoint => ({
	timeMs,
	cx,
	cy,
	visible: true,
	interactionType: "click",
});

const move = (timeMs: number, cx: number, cy: number): CursorTelemetryPoint => ({
	timeMs,
	cx,
	cy,
	visible: true,
	interactionType: "move",
});

describe("suggestSteps", () => {
	it("counts a move as nothing: sweeping the cursor is not a step", () => {
		// The failure this guards: treating any sample as intent puts a boundary on every
		// cursor move, and a 30 s take turns into forty "steps".
		expect(suggestSteps([move(1000, 100, 100), move(4000, 900, 700)])).toEqual([]);
	});

	it("merges clicks in one place inside the gap into a single step", () => {
		const steps = suggestSteps([
			click(1000, 100, 100),
			click(1600, 108, 104),
			click(2200, 96, 99),
		]);
		expect(steps).toHaveLength(1);
		expect(steps[0]).toEqual({ startMs: 1000, clicks: 3 });
	});

	it("starts a new step after a pause long enough to read something", () => {
		const steps = suggestSteps([click(1000, 100, 100), click(5000, 110, 105)]);
		expect(steps.map((s) => s.startMs)).toEqual([1000, 5000]);
	});

	it("starts a new step when the click lands in a different part of the screen", () => {
		const steps = suggestSteps([click(1000, 100, 100), click(2000, 1500, 900)], {
			frameWidth: 1920,
			frameHeight: 1080,
		});
		expect(steps.map((s) => s.startMs)).toEqual([1000, 2000]);
	});

	it("measures drift from the group's first click, so slow travel still splits", () => {
		// Each hop is small; the cumulative move is not. Comparing with the previous click
		// would call this one place and hide two separate actions.
		const steps = suggestSteps(
			[
				click(1000, 0, 0),
				click(1400, 200, 150),
				click(1800, 400, 300),
				click(2200, 600, 450),
			],
			{ frameWidth: 1920, frameHeight: 1080, regionFraction: 0.28 },
		);
		expect(steps.length).toBeGreaterThan(1);
	});

	it("caps the count, keeping the earliest steps", () => {
		const many = Array.from({ length: 20 }, (_, i) => click(i * 5000, 100 + i, 100));
		const steps = suggestSteps(many, { maxSteps: 8 });
		expect(steps).toHaveLength(8);
		expect(steps[0].startMs).toBe(0);
	});

	it("returns nothing for a take with no clicks at all", () => {
		expect(suggestSteps([])).toEqual([]);
	});
});
