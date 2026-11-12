import { describe, expect, it } from "vitest";
import type { AxcutDocument } from "../schema";
import { markerSourceTimeAtRawTime, mergeMarkers, moveMarkerToRawTime } from "./markers";

const clip = (id: string, assetId: string, srcStart: number, srcEnd: number, tlStart: number) => ({
	id,
	assetId,
	sourceStartSec: srcStart,
	sourceEndSec: srcEnd,
	timelineStartSec: tlStart,
	timelineEndSec: tlStart + (srcEnd - srcStart),
	wordRefs: [],
	origin: "system" as const,
	reason: "",
});

const doc = (markers: Array<{ id: string; assetId?: string; sourceTimeSec: number; label?: string }>, clips: unknown[]) =>
	({
		timeline: { clips },
		markers: markers.map((m, i) => ({
			...m,
			label: m.label ?? `step ${i}`,
			createdAt: "2026-01-01T00:00:00.000Z",
		})),
	}) as unknown as AxcutDocument;

describe("markerSourceTimeAtRawTime", () => {
	it("inverts the clip offset: raw 12 s on a clip starting at raw 10 s is source 2 s", () => {
		const d = doc([], [clip("c1", "a1", 0, 5, 10)]);
		expect(markerSourceTimeAtRawTime(d, 12)).toEqual({ assetId: "a1", sourceTimeSec: 2 });
	});

	it("picks the clip that actually covers the moment, not the first one", () => {
		const d = doc([], [clip("c1", "a1", 0, 5, 0), clip("c2", "a2", 30, 40, 5)]);
		expect(markerSourceTimeAtRawTime(d, 7)).toEqual({ assetId: "a2", sourceTimeSec: 32 });
	});

	it("returns null on empty timeline rather than guessing a neighbour", () => {
		const d = doc([], [clip("c1", "a1", 0, 5, 0)]);
		expect(markerSourceTimeAtRawTime(d, 9)).toBeNull();
	});

	it("will not place a marker on a different asset when one is required", () => {
		const d = doc([], [clip("c1", "a1", 0, 5, 0), clip("c2", "a2", 0, 5, 5)]);
		expect(markerSourceTimeAtRawTime(d, 6, "a1")).toBeNull();
	});
});

describe("moveMarkerToRawTime", () => {
	it("moves the marker and leaves id, label and createdAt alone", () => {
		const d = doc([{ id: "m1", assetId: "a1", sourceTimeSec: 1, label: "Open" }], [clip("c1", "a1", 0, 5, 10)]);
		const next = moveMarkerToRawTime(d, "m1", 13);
		const m = next.markers[0];
		expect(m.id).toBe("m1");
		expect(m.label).toBe("Open");
		expect(m.createdAt).toBe("2026-01-01T00:00:00.000Z");
		expect(m.sourceTimeSec).toBeCloseTo(3, 6);
	});

	it("is a no-op when the moment has no clip under it", () => {
		const d = doc([{ id: "m1", assetId: "a1", sourceTimeSec: 1 }], [clip("c1", "a1", 0, 5, 0)]);
		expect(moveMarkerToRawTime(d, "m1", 99)).toBe(d);
	});
});

describe("mergeMarkers", () => {
	it("keeps the earliest, its id, and drops the rest", () => {
		const d = doc(
			[
				{ id: "m1", assetId: "a1", sourceTimeSec: 5, label: "second" },
				{ id: "m2", assetId: "a1", sourceTimeSec: 2, label: "first" },
				{ id: "m3", assetId: "a1", sourceTimeSec: 9 },
			],
			[clip("c1", "a1", 0, 20, 0)],
		);
		const next = mergeMarkers(d, ["m1", "m2", "m3"]);
		expect(next.markers).toHaveLength(1);
		expect(next.markers[0].id).toBe("m2");
		expect(next.markers[0].label).toBe("first");
		expect(next.markers[0].sourceTimeSec).toBe(2);
	});

	it("refuses to merge across assets rather than comparing two rulers", () => {
		const d = doc(
			[
				{ id: "m1", assetId: "a1", sourceTimeSec: 1 },
				{ id: "m2", assetId: "a2", sourceTimeSec: 2 },
			],
			[clip("c1", "a1", 0, 20, 0), clip("c2", "a2", 0, 20, 20)],
		);
		expect(mergeMarkers(d, ["m1", "m2"])).toBe(d);
	});

	it("needs at least two markers", () => {
		const d = doc([{ id: "m1", assetId: "a1", sourceTimeSec: 1 }], [clip("c1", "a1", 0, 20, 0)]);
		expect(mergeMarkers(d, ["m1"])).toBe(d);
	});
});
