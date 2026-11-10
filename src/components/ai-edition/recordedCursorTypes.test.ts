import { describe, expect, it } from "vitest";
import {
	cursorCapabilitiesOf,
	cursorStateChanges,
	cursorStatesBetween,
} from "./recordedCursorTypes";

/**
 * What the pane may offer, from a sidecar alone.
 *
 * The three questions are deliberately separate: a take can carry a usable pointer position and
 * clicks without ever naming a cursor shape (which is what a sidecar recorded through a remote
 * session looks like), and the pane used to hide itself in exactly that case — so every ripple,
 * trail and halo setting became unreachable on footage that could show all three.
 */
describe("cursorCapabilitiesOf", () => {
	const position = (t: number, cx = 0.5, cy = 0.5) => ({
		timeMs: t,
		cx,
		cy,
		visible: true,
		interactionType: "move" as const,
	});

	it("reads a take with positions but no named shapes as drawable", () => {
		// The real case: 122 samples, every `cursorType` null.
		const samples = Array.from({ length: 122 }, (_, i) => position(i * 33));
		expect(cursorCapabilitiesOf(samples)).toEqual({
			position: true,
			clicks: false,
			shapes: false,
		});
	});

	it("separates clicks from shapes", () => {
		const samples = [position(0), { ...position(100), interactionType: "right-click" as const }];
		expect(cursorCapabilitiesOf(samples)).toMatchObject({
			position: true,
			clicks: true,
			shapes: false,
		});

		const named = [{ ...position(0), cursorType: "pointer" }];
		expect(cursorCapabilitiesOf(named)).toMatchObject({ shapes: true, clicks: false });
	});

	it("does not call an empty or unusable recording drawable", () => {
		expect(cursorCapabilitiesOf([])).toEqual({ position: false, clicks: false, shapes: false });
		// A timestamp that is not a number, or a point outside the frame, is not a position: the
		// compositor would clip it away, so there is nothing to draw.
		expect(cursorCapabilitiesOf([{ timeMs: Number.NaN, cx: 0.5, cy: 0.5 }]).position).toBe(false);
		expect(cursorCapabilitiesOf([{ timeMs: 0, cx: 1.4, cy: 0.5 }]).position).toBe(false);
		expect(cursorCapabilitiesOf([{ timeMs: -5, cx: 0.5, cy: 0.5 }]).position).toBe(false);
		expect(
			cursorCapabilitiesOf([{ timeMs: 0, cx: 0.5, cy: Number.POSITIVE_INFINITY }]).position,
		).toBe(false);
	});

	it("ignores a click on a sample whose position is unusable", () => {
		// The click is still a click: it has a timestamp the timeline can place, so the ripple
		// settings apply even though this one sample's point would be clipped.
		const samples = [{ timeMs: 0, cx: Number.NaN, cy: 0.5, interactionType: "click" as const }];
		expect(cursorCapabilitiesOf(samples)).toMatchObject({ position: false, clicks: true });
	});
});

describe("cursorStateChanges", () => {
	it("keeps the changes only, and reads a sample with no state as the arrow", () => {
		expect(
			cursorStateChanges([
				{ timeMs: 0, cursorType: null },
				{ timeMs: 33, cursorType: "arrow" },
				{ timeMs: 66, cursorType: "text" },
				{ timeMs: 99, cursorType: "text" },
				{ timeMs: 132 },
			]),
		).toEqual([
			{ timeMs: 0, type: "arrow" },
			{ timeMs: 66, type: "text" },
			{ timeMs: 132, type: "arrow" },
		]);
	});
});

describe("cursorStatesBetween", () => {
	const changes = cursorStateChanges([
		{ timeMs: 1000, cursorType: "pointer" },
		{ timeMs: 2000, cursorType: "text" },
		{ timeMs: 3000, cursorType: "resize-ew" },
	]);

	it("counts the state in force at the start and each change up to the end", () => {
		expect(cursorStatesBetween(changes, 1500, 2500)).toEqual(new Set(["pointer", "text"]));
	});

	// A clip trimmed past a state never puts it on screen.
	it("leaves out what comes after the end", () => {
		expect(cursorStatesBetween(changes, 0, 1500)).toEqual(new Set(["arrow", "pointer"]));
		expect(cursorStatesBetween(changes, 3500, 9000)).toEqual(new Set(["resize-ew"]));
	});
});
