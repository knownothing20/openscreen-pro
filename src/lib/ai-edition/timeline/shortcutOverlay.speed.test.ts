import { describe, expect, it } from "vitest";
import {
	DEFAULT_SHORTCUT_OVERLAY,
	shortcutCardSpans,
	sourceSpanSecForOutputSec,
} from "./shortcutOverlay";

const ON = { ...DEFAULT_SHORTCUT_OVERLAY, enabled: true, durationMs: 1500 };

const region = (startSec: number, endSec: number, speed: number) => ({
	id: `r-${startSec}-${speed}`,
	startMs: startSec * 1000,
	endMs: endSec * 1000,
	speed,
});

const clip = (start: number, end: number, path = "C://take.mp4") => ({
	screenPath: path,
	sourceStartSec: start,
	sourceEndSec: end,
});

const event = (timeMs: number) => ({ timeMs, combo: "Ctrl+S" });

describe("sourceSpanSecForOutputSec", () => {
	it("is the identity when nothing is sped up", () => {
		expect(sourceSpanSecForOutputSec(2.5, 1.5)).toBeCloseTo(1.5, 3);
	});

	it("covers twice the source under 2x, so 1.5 s of programme stays 1.5 s", () => {
		// The bug this fixes: the card used to last 1.5 s of SOURCE, which plays for 0.75 s.
		expect(sourceSpanSecForOutputSec(0, 1.5, [region(0, 10, 2)])).toBeCloseTo(3.0, 2);
	});

	it("covers less source under 0.5x", () => {
		expect(sourceSpanSecForOutputSec(0, 1.5, [region(0, 10, 0.5)])).toBeCloseTo(0.75, 2);
	});

	it("integrates across a speed boundary instead of using one multiplier", () => {
		// 0–1 s at 2x has 0.5 s of programme; the remaining 1.0 s is 1x, so 1.0 s of source.
		const span = sourceSpanSecForOutputSec(0, 1.5, [region(0, 1, 2)]);
		expect(span).toBeCloseTo(2.0, 2);
	});
});

describe("shortcutCardSpans with speed regions", () => {
	it("keeps the card on screen for the set duration of programme at 2x", () => {
		const spans = shortcutCardSpans([clip(0, 10)], [event(2500)], ON, "C://take.mp4", [
			region(0, 10, 2),
		]);
		expect(spans).toHaveLength(1);
		expect(spans[0].endSec - spans[0].startSec).toBeCloseTo(3.0, 2);
	});

	it("carries across a contiguous split rather than being cut in half", () => {
		// Split at source 3 s, same take playing straight through. The card starts at 2.5 s and
		// should finish at 5.5 s (1.5 s of programme at 1x), i.e. two span pieces.
		const spans = shortcutCardSpans(
			[clip(0, 3), clip(3, 10)],
			[event(2500)],
			ON,
			"C://take.mp4",
			[],
		);
		expect(spans).toHaveLength(2);
		expect(spans[0].endSec).toBeCloseTo(3.0, 3);
		expect(spans[1].startSec).toBeCloseTo(3.0, 3);
		expect(spans[1].endSec - spans[1].startSec).toBeCloseTo(1.0, 3);
	});

	it("stops at the cut when the next clip does not continue the same take", () => {
		// Trimmed away the middle: 0–3 then 7–10. Nothing on the far side may carry the card.
		const spans = shortcutCardSpans(
			[clip(0, 3), clip(7, 10)],
			[event(2500)],
			ON,
			"C://take.mp4",
			[],
		);
		expect(spans).toHaveLength(1);
		expect(spans[0].endSec).toBeCloseTo(3.0, 3);
	});

	it("does not show the card when the trigger was trimmed away", () => {
		const spans = shortcutCardSpans([clip(4, 10)], [event(2500)], ON, "C://take.mp4", []);
		expect(spans).toEqual([]);
	});
});
