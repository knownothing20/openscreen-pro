import { describe, expect, it } from "vitest";
import {
	DEFAULT_SHORTCUT_OVERLAY,
	looksLikeChord,
	shortcutCardAt,
	shortcutCardSpans,
} from "./shortcutOverlay";

const ON = { ...DEFAULT_SHORTCUT_OVERLAY, enabled: true, durationMs: 1000 };
const CHORDS = [
	{ timeMs: 2000, combo: "Ctrl+S" },
	{ timeMs: 5000, combo: "Ctrl+Shift+P" },
];

describe("shortcutCardAt", () => {
	it("draws nothing when the overlay is off, or the take has no chords", () => {
		expect(shortcutCardAt(CHORDS, { ...ON, enabled: false }, 2100)).toBeNull();
		expect(shortcutCardAt([], ON, 2100)).toBeNull();
		expect(shortcutCardAt(null, ON, 2100)).toBeNull();
	});

	it("shows the chord only inside its window", () => {
		// Before the press, and exactly at the end of the window: both empty. A card that lingers
		// past its duration is what leaves a ghost overlay after a seek backwards.
		expect(shortcutCardAt(CHORDS, ON, 1999)).toBeNull();
		expect(shortcutCardAt(CHORDS, ON, 2000)?.combo).toBe("Ctrl+S");
		expect(shortcutCardAt(CHORDS, ON, 2999)?.combo).toBe("Ctrl+S");
		expect(shortcutCardAt(CHORDS, ON, 3000)).toBeNull();
	});

	it("answers the same whichever direction the playhead came from", () => {
		// The function takes only a time, so this is really a promise about the caller: there is no
		// state to carry. Frames sampled out of order must agree with frames sampled in order.
		const forward = [1900, 2100, 2600, 3100, 5100].map(
			(t) => shortcutCardAt(CHORDS, ON, t)?.combo ?? null,
		);
		expect(forward).toEqual([null, "Ctrl+S", "Ctrl+S", null, "Ctrl+Shift+P"]);
		const backward = [5100, 3100, 2600, 2100, 1900]
			.map((t) => shortcutCardAt(CHORDS, ON, t)?.combo ?? null)
			.reverse();
		expect(backward).toEqual(forward);
	});

	it("lets the newer press win when two windows overlap", () => {
		const overlapping = [
			{ timeMs: 0, combo: "Ctrl+A" },
			{ timeMs: 500, combo: "Ctrl+B" },
		];
		expect(shortcutCardAt(overlapping, { ...ON, durationMs: 2000 }, 800)?.combo).toBe("Ctrl+B");
	});

	it("reports progress through the card for the enter/exit fade", () => {
		expect(shortcutCardAt(CHORDS, ON, 2000)?.progress).toBe(0);
		expect(shortcutCardAt(CHORDS, ON, 2500)?.progress).toBeCloseTo(0.5, 3);
		expect(shortcutCardAt(CHORDS, ON, 2999)?.progress).toBeGreaterThan(0.99);
	});

	it("refuses to paint anything that is not a chord", () => {
		// The sidecar is meant to hold chords only; this is the gate at the drawing end. Typed text
		// must never reach the screen even if it reached the file.
		const withText = [
			{ timeMs: 0, combo: "hunter2" },
			{ timeMs: 10, combo: "a" },
			{ timeMs: 20, combo: "Ctrl" },
			{ timeMs: 30, combo: "my password is 1234" },
		];
		for (const { timeMs } of withText) {
			expect(shortcutCardAt(withText, { ...ON, durationMs: 5000 }, timeMs + 100)).toBeNull();
		}
	});
});

describe("looksLikeChord", () => {
	it("accepts the forms a recording actually produces", () => {
		for (const combo of [
			"Ctrl+S",
			"Ctrl+Shift+P",
			"Alt+Tab",
			"Cmd+Z",
			"F5",
			"Ctrl+Alt+Delete",
			"Shift+F10",
		]) {
			expect(looksLikeChord(combo), combo).toBe(true);
		}
	});

	it("rejects prose, single letters and bare modifiers", () => {
		for (const combo of [
			"hello",
			"a",
			"Ctrl",
			"Ctrl+",
			"   ",
			"this is not a chord at all",
			"Ctrl+" + "x".repeat(20),
		]) {
			expect(looksLikeChord(combo), combo).toBe(false);
		}
	});
});

describe("shortcutCardSpans", () => {
	const CLIPS = [
		{ screenPath: "C://take.mp4", sourceStartSec: 0, sourceEndSec: 10 },
		{ screenPath: "C://take.mp4", sourceStartSec: 10, sourceEndSec: 20 },
	];
	const ON = { ...DEFAULT_SHORTCUT_OVERLAY, enabled: true, durationMs: 2000 };
	const EVENTS = [
		{ timeMs: 2000, combo: "Ctrl+S" },
		{ timeMs: 15000, combo: "Alt+Tab" },
	];

	it("places each chord on the clip that plays its footage", () => {
		const spans = shortcutCardSpans(CLIPS, EVENTS, ON, "C://take.mp4");
		expect(spans.map((s) => [s.clipIndex, s.startSec, s.combo])).toEqual([
			[0, 2, "Ctrl+S"],
			[1, 15, "Alt+Tab"],
		]);
	});

	it("drops only the chord the trim removed", () => {
		// The 2 s chord is behind the new in-point, so its footage is gone. The 15 s chord is
		// still inside the take: a trim is not a reason to lose every card in the clip.
		const trimmed = [{ screenPath: "C://take.mp4", sourceStartSec: 8, sourceEndSec: 20 }];
		expect(shortcutCardSpans(trimmed, EVENTS, ON, "C://take.mp4").map((s) => s.combo)).toEqual([
			"Alt+Tab",
		]);
	});

	it("starts the chord on the side of a split that plays it, and carries on past the cut", () => {
		// A split cuts the SOURCE into two windows; 2.5 s is only inside the first, so that is
		// where the card starts. It used to stop dead at the cut, which made a 3 s card last
		// 0.5 s whenever the user split in the middle of it — the two windows play the same
		// take back to back, so the card continues (V2.8, programme-time duration).
		const split = [
			{ screenPath: "C://take.mp4", sourceStartSec: 1, sourceEndSec: 3 },
			{ screenPath: "C://take.mp4", sourceStartSec: 3, sourceEndSec: 5 },
		];
		const spans = shortcutCardSpans(
			split,
			[{ timeMs: 2500, combo: "Ctrl+S" }],
			{ ...ON, durationMs: 3000 },
			"C://take.mp4",
		);
		expect(spans.map((s) => [s.clipIndex, s.startSec, s.endSec])).toEqual([
			[0, 2.5, 3],
			[1, 3, 5],
		]);
	});

	it("never bleeds into the next clip", () => {
		const spans = shortcutCardSpans(
			[{ screenPath: "C://take.mp4", sourceStartSec: 0, sourceEndSec: 3 }],
			[{ timeMs: 2900, combo: "Ctrl+S" }],
			{ ...ON, durationMs: 5000 },
			"C://take.mp4",
		);
		expect(spans[0].endSec).toBe(3);
	});

	it("keeps one take's chords off another take's clips", () => {
		const mixed = [
			{ screenPath: "C://a.mp4", sourceStartSec: 0, sourceEndSec: 20 },
			{ screenPath: "C://b.mp4", sourceStartSec: 0, sourceEndSec: 20 },
		];
		const spans = shortcutCardSpans(mixed, [{ timeMs: 5000, combo: "Ctrl+S" }], ON, "C://b.mp4");
		expect(spans.map((s) => s.clipIndex)).toEqual([1]);
	});

	it("draws nothing when the overlay is off", () => {
		expect(shortcutCardSpans(CLIPS, EVENTS, { ...ON, enabled: false }, "C://take.mp4")).toEqual([]);
	});
});
