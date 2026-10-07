// The recording session is the wire shape a take travels in — HUD → main → editor — so
// these tests are about what survives that trip, and about what a `.session.json` written
// before markers existed does to the normalizer.

import { describe, expect, it } from "vitest";
import { normalizeRecordingMarkerInput, normalizeRecordingSession } from "./recordingSession";

const BASE = {
	screenVideoPath: "C:/recordings/recording-1.mp4",
	createdAt: 1_700_000_000_000,
};

describe("normalizeRecordingSession", () => {
	it("keeps a session with no markers free of the key entirely", () => {
		const session = normalizeRecordingSession(BASE);
		expect(session).not.toBeNull();
		expect("markers" in (session as object)).toBe(false);
	});

	it("opens a manifest written before markers existed", () => {
		// Exactly the shape the older builds wrote: no `markers` key at all.
		const session = normalizeRecordingSession({ ...BASE, cursorCaptureMode: "system" });
		expect(session?.screenVideoPath).toBe(BASE.screenVideoPath);
		expect(session?.markers).toBeUndefined();
	});

	it("keeps the markers of a take that has them, in order", () => {
		const session = normalizeRecordingSession({
			...BASE,
			markers: [
				{
					id: "marker_a",
					sourceTimeSec: 12.5,
					label: "retake",
					createdAt: "2026-10-07T10:00:00.000Z",
				},
				{ id: "marker_b", sourceTimeSec: 40 },
			],
		});
		expect(session?.markers).toEqual([
			{
				id: "marker_a",
				sourceTimeSec: 12.5,
				label: "retake",
				createdAt: "2026-10-07T10:00:00.000Z",
			},
			{ id: "marker_b", sourceTimeSec: 40 },
		]);
	});

	it("drops a malformed marker instead of refusing the take", () => {
		const session = normalizeRecordingSession({
			...BASE,
			markers: [
				{ id: "marker_ok", sourceTimeSec: 3 },
				{ sourceTimeSec: 4 },
				{ id: "marker_bad", sourceTimeSec: Number.NaN },
				{ id: "marker_also_bad", sourceTimeSec: "5" },
				null,
				"nope",
			],
		});
		expect(session?.markers).toEqual([{ id: "marker_ok", sourceTimeSec: 3 }]);
	});

	it("clamps a negative second and ignores a non-string label or timestamp", () => {
		const session = normalizeRecordingSession({
			...BASE,
			markers: [{ id: "marker_a", sourceTimeSec: -8, label: 7, createdAt: 42 }],
		});
		expect(session?.markers).toEqual([{ id: "marker_a", sourceTimeSec: 0 }]);
	});

	it("treats an empty or non-array marker list as no markers", () => {
		expect(normalizeRecordingSession({ ...BASE, markers: [] })?.markers).toBeUndefined();
		expect(normalizeRecordingSession({ ...BASE, markers: "nope" })?.markers).toBeUndefined();
	});

	it("still refuses a session with no screen path", () => {
		expect(normalizeRecordingSession({ createdAt: 1, markers: [] })).toBeNull();
		expect(normalizeRecordingSession(null)).toBeNull();
	});
});

describe("normalizeRecordingMarkerInput", () => {
	it("accepts the drop shape the HUD sends and returns it unchanged", () => {
		expect(normalizeRecordingMarkerInput({ id: "marker_a", sourceTimeSec: 9 })).toEqual({
			id: "marker_a",
			sourceTimeSec: 9,
		});
	});

	it("rejects anything without an id or a finite second", () => {
		expect(normalizeRecordingMarkerInput({ sourceTimeSec: 1 })).toBeNull();
		expect(normalizeRecordingMarkerInput({ id: "marker_a" })).toBeNull();
		expect(
			normalizeRecordingMarkerInput({ id: "marker_a", sourceTimeSec: Number.POSITIVE_INFINITY }),
		).toBeNull();
		expect(normalizeRecordingMarkerInput(undefined)).toBeNull();
	});
});
