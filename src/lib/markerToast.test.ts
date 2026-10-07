// The notice opacity is read in three places that have to agree — main's default and
// clamp, the HUD's paint, and the settings dialog's option list — so its rules are pinned
// here rather than discovered by a dialog that shows nothing selected.

import { describe, expect, it } from "vitest";
import { HUD_BAR_BOTTOM } from "@/components/launch/hudGeometry";
import {
	clampMarkerToastOpacity,
	DEFAULT_MARKER_TOAST_OPACITY,
	MARKER_TOAST_OFFSET_PX,
	MARKER_TOAST_OPACITY_LEVELS,
	MIN_MARKER_TOAST_OPACITY,
} from "./markerToast";

describe("clampMarkerToastOpacity", () => {
	it("keeps a value inside the usable range as written", () => {
		expect(clampMarkerToastOpacity(0.6)).toBe(0.6);
		expect(clampMarkerToastOpacity(1)).toBe(1);
		expect(clampMarkerToastOpacity(MIN_MARKER_TOAST_OPACITY)).toBe(MIN_MARKER_TOAST_OPACITY);
	});

	it("answers an absent or unusable value with the default", () => {
		// Absent is the case that matters: every settings file written before the setting
		// existed has no such key.
		expect(clampMarkerToastOpacity(undefined)).toBe(DEFAULT_MARKER_TOAST_OPACITY);
		expect(clampMarkerToastOpacity(null)).toBe(DEFAULT_MARKER_TOAST_OPACITY);
		expect(clampMarkerToastOpacity("0.5")).toBe(DEFAULT_MARKER_TOAST_OPACITY);
		expect(clampMarkerToastOpacity(Number.NaN)).toBe(DEFAULT_MARKER_TOAST_OPACITY);
		expect(clampMarkerToastOpacity(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MARKER_TOAST_OPACITY);
	});

	it("lifts anything below the floor, so a notice cannot be made unreadable", () => {
		expect(clampMarkerToastOpacity(0)).toBe(MIN_MARKER_TOAST_OPACITY);
		expect(clampMarkerToastOpacity(-3)).toBe(MIN_MARKER_TOAST_OPACITY);
	});

	it("caps anything above fully opaque", () => {
		expect(clampMarkerToastOpacity(4)).toBe(1);
	});
});

describe("the levels the settings dialog offers", () => {
	it("contains the default, so the dialog always shows a selected option", () => {
		expect(MARKER_TOAST_OPACITY_LEVELS).toContain(DEFAULT_MARKER_TOAST_OPACITY);
	});

	it("is ordered most opaque first and never below the floor", () => {
		const levels = [...MARKER_TOAST_OPACITY_LEVELS];
		expect(levels).toEqual([...levels].sort((a, b) => b - a));
		for (const level of levels) expect(level).toBeGreaterThanOrEqual(MIN_MARKER_TOAST_OPACITY);
	});

	it("puts every level through the clamp unchanged", () => {
		for (const level of MARKER_TOAST_OPACITY_LEVELS) {
			expect(clampMarkerToastOpacity(level)).toBe(level);
		}
	});
});

describe("MARKER_TOAST_OFFSET_PX", () => {
	it("clears the control bar it is meant to keep out of the way", () => {
		// The bar is bottom-anchored, so the notice has to rise past the bar's own height
		// plus its margin. The bar measures ~56px; the assertion is against the margin
		// constant plus that height so a later change to either shows up here.
		expect(MARKER_TOAST_OFFSET_PX).toBeGreaterThan(HUD_BAR_BOTTOM + 56);
	});
});
