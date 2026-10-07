// Recording markers: the model, its serialization, and the two behaviours the feature
// exists for — a marker survives a reopen, and a marker follows its footage through a
// trim and a reorder instead of being pinned to the ruler.

import { describe, expect, it } from "vitest";
import { type AxcutClip, type AxcutDocument, createEmptyDocument, documentSchema } from "../schema";
import {
	addMarker,
	bindMarkersToAsset,
	createMarker,
	markerRawTimeSec,
	markersFromSession,
	removeMarker,
	setMarkerLabel,
	sortMarkers,
	visibleMarkers,
} from "./markers";

const ASSET = "asset_1";
const CREATED_AT = "2026-10-07T10:00:00.000Z";

function makeClip(overrides: Partial<AxcutClip> = {}): AxcutClip {
	return {
		id: "clip_1",
		assetId: ASSET,
		sourceStartSec: 0,
		sourceEndSec: 60,
		timelineStartSec: 0,
		timelineEndSec: 60,
		wordRefs: [],
		origin: "user",
		reason: "",
		...overrides,
	};
}

function makeDoc(clips: AxcutClip[]): AxcutDocument {
	const base = createEmptyDocument({ title: "Test", projectId: "proj_markers" });
	return {
		...base,
		project: { ...base.project, primaryAssetId: ASSET },
		assets: [
			{
				id: ASSET,
				kind: "video" as const,
				label: "Recording",
				originalPath: "C:/videos/rec.mp4",
				durationSec: 600,
				cameraTrack: null,
			},
		],
		timeline: { ...base.timeline, clips },
	};
}

/** A marker dropped at `sourceTimeSec` on the recording, as the HUD would create it. */
function droppedAt(sourceTimeSec: number, assetId: string | undefined = ASSET) {
	return createMarker({ assetId, sourceTimeSec, createdAt: CREATED_AT });
}

describe("marker model", () => {
	it("creates a marker with a stable id prefix, the dropped second, and no label", () => {
		const marker = droppedAt(12.5);
		expect(marker.id.startsWith("marker_")).toBe(true);
		expect(marker.sourceTimeSec).toBe(12.5);
		expect(marker.label).toBe("");
		expect(marker.assetId).toBe(ASSET);
		expect(marker.createdAt).toBe(CREATED_AT);
	});

	it("clamps a non-finite or negative drop to zero rather than storing a bad second", () => {
		expect(createMarker({ sourceTimeSec: -4 }).sourceTimeSec).toBe(0);
		expect(createMarker({ sourceTimeSec: Number.NaN }).sourceTimeSec).toBe(0);
	});

	it("keeps a marker with no asset yet unbound instead of inventing an asset id", () => {
		const marker = createMarker({ sourceTimeSec: 3, createdAt: CREATED_AT });
		expect(marker.assetId).toBeUndefined();
	});

	it("appends in source order and leaves the previous document untouched", () => {
		const doc = makeDoc([makeClip()]);
		const first = addMarker(doc, { assetId: ASSET, sourceTimeSec: 30, createdAt: CREATED_AT });
		const second = addMarker(first, { assetId: ASSET, sourceTimeSec: 10, createdAt: CREATED_AT });
		expect(doc.markers).toHaveLength(0);
		expect(first.markers).toHaveLength(1);
		expect(second.markers.map((m) => m.sourceTimeSec)).toEqual([10, 30]);
	});

	it("sorts without mutating the input array", () => {
		const markers = [droppedAt(30), droppedAt(10)];
		const sorted = sortMarkers(markers);
		expect(sorted.map((m) => m.sourceTimeSec)).toEqual([10, 30]);
		expect(markers.map((m) => m.sourceTimeSec)).toEqual([30, 10]);
	});
});

describe("delete and relabel", () => {
	it("removes only the named marker", () => {
		const doc = addMarker(
			addMarker(makeDoc([makeClip()]), {
				assetId: ASSET,
				sourceTimeSec: 10,
				createdAt: CREATED_AT,
			}),
			{ assetId: ASSET, sourceTimeSec: 20, createdAt: CREATED_AT },
		);
		const target = doc.markers[0];
		const next = removeMarker(doc, target.id);
		expect(next.markers).toHaveLength(1);
		expect(next.markers[0].sourceTimeSec).toBe(20);
	});

	it("returns the same document when the id is unknown", () => {
		const doc = addMarker(makeDoc([makeClip()]), {
			assetId: ASSET,
			sourceTimeSec: 10,
			createdAt: CREATED_AT,
		});
		expect(removeMarker(doc, "marker_nope")).toBe(doc);
		expect(setMarkerLabel(doc, "marker_nope", "x")).toBe(doc);
	});

	it("relabels one marker and returns the same document when the label already matches", () => {
		const doc = addMarker(makeDoc([makeClip()]), {
			assetId: ASSET,
			sourceTimeSec: 10,
			createdAt: CREATED_AT,
		});
		const id = doc.markers[0].id;
		const labelled = setMarkerLabel(doc, id, "retake");
		expect(labelled.markers[0].label).toBe("retake");
		expect(doc.markers[0].label).toBe("");
		expect(setMarkerLabel(labelled, id, "retake")).toBe(labelled);
	});
});

describe("timeline mapping", () => {
	it("maps a source second onto the ruler through its clip", () => {
		const doc = makeDoc([makeClip()]);
		expect(markerRawTimeSec(droppedAt(12), doc.timeline.clips)).toBe(12);
	});

	it("shifts with the clip when the clip does not start at zero", () => {
		const clips = [
			makeClip({ sourceStartSec: 10, sourceEndSec: 60, timelineStartSec: 0, timelineEndSec: 50 }),
		];
		expect(markerRawTimeSec(droppedAt(25), clips)).toBe(15);
	});

	it("hides a marker whose second was trimmed away, and shows it again when the trim is restored", () => {
		const full = makeDoc([makeClip()]);
		const trimmed = makeDoc([
			makeClip({ sourceStartSec: 10, sourceEndSec: 60, timelineStartSec: 0, timelineEndSec: 50 }),
		]);
		const marker = droppedAt(4);
		const docWithMarker = { ...full, markers: [marker] };

		// Out of view: the clip no longer draws source second 4.
		expect(visibleMarkers({ ...docWithMarker, timeline: trimmed.timeline })).toEqual([]);
		// Nothing was rewritten on the way — the same stored marker resolves again once the
		// clip covers its second, which is what makes the trim undoable.
		expect(docWithMarker.markers).toEqual([marker]);
		expect(visibleMarkers(docWithMarker)).toEqual([{ marker, rawTimeSec: 4 }]);
	});

	it("follows a reordered clip instead of staying on its old ruler position", () => {
		// The take is split in two and the second half is moved to the front.
		const clips = [
			makeClip({
				id: "clip_2",
				sourceStartSec: 60,
				sourceEndSec: 120,
				timelineStartSec: 0,
				timelineEndSec: 60,
			}),
			makeClip({
				id: "clip_1",
				sourceStartSec: 0,
				sourceEndSec: 60,
				timelineStartSec: 60,
				timelineEndSec: 120,
			}),
		];
		const doc = { ...makeDoc(clips), markers: [droppedAt(90)] };
		expect(visibleMarkers(doc)).toEqual([{ marker: doc.markers[0], rawTimeSec: 30 }]);
	});

	it("ignores a clip of another asset", () => {
		const clips = [makeClip({ assetId: "asset_other" })];
		expect(markerRawTimeSec(droppedAt(12), clips)).toBeNull();
	});

	it("resolves an unbound marker (still in the recording session) against any clip", () => {
		const clips = [makeClip()];
		const unbound = createMarker({ sourceTimeSec: 12, createdAt: CREATED_AT });
		expect(markerRawTimeSec(unbound, clips)).toBe(12);
	});

	it("hides a marker past the end of a clip that is still on the pre-probe seed", () => {
		// The 60s seed the import writes before the real duration lands. The ruler is only
		// 60s long at that point, so a marker deeper in the take has no position to occupy —
		// and is NOT mapped onto some other clip that happens to look open-ended.
		expect(markerRawTimeSec(droppedAt(200), [makeClip({ sourceEndSec: 60 })])).toBeNull();
		// The probe extends the clip, and the same stored marker resolves where it belongs.
		expect(
			markerRawTimeSec(droppedAt(200), [makeClip({ sourceEndSec: 600, timelineEndSec: 600 })]),
		).toBe(200);
	});

	// `duplicateClip` puts the same footage on the timeline twice, so one source second is
	// drawn by two clips. One tick, at the earliest copy — and the array is deliberately out
	// of ruler order, because which copy wins must not depend on how the clips are stored.
	it("shows a duplicated take's marker once, at the earliest copy", () => {
		const clips = [
			makeClip({ id: "clip_b", timelineStartSec: 60, timelineEndSec: 120 }),
			makeClip({ id: "clip_a", timelineStartSec: 0, timelineEndSec: 60 }),
		];
		expect(markerRawTimeSec(droppedAt(12), clips)).toBe(12);
	});

	it("returns visible markers in ruler order", () => {
		const clips = [
			makeClip({
				id: "clip_1",
				sourceStartSec: 0,
				sourceEndSec: 60,
				timelineStartSec: 60,
				timelineEndSec: 120,
			}),
			makeClip({
				id: "clip_2",
				sourceStartSec: 60,
				sourceEndSec: 120,
				timelineStartSec: 0,
				timelineEndSec: 60,
			}),
		];
		const doc = {
			...makeDoc(clips),
			markers: [droppedAt(90), droppedAt(10), droppedAt(70)],
		};
		expect(visibleMarkers(doc).map((entry) => entry.rawTimeSec)).toEqual([10, 30, 70]);
	});
});

describe("binding session markers to the imported asset", () => {
	it("gives unbound markers the asset and keeps an already-bound one", () => {
		const doc = makeDoc([makeClip()]);
		const unbound = createMarker({ sourceTimeSec: 5, createdAt: CREATED_AT });
		const bound = createMarker({ assetId: "asset_other", sourceTimeSec: 8, createdAt: CREATED_AT });
		const next = bindMarkersToAsset(doc, ASSET, [unbound, bound]);
		expect(next.markers.find((m) => m.id === unbound.id)?.assetId).toBe(ASSET);
		expect(next.markers.find((m) => m.id === bound.id)?.assetId).toBe("asset_other");
	});

	it("does not double a marker when the import runs twice", () => {
		const doc = makeDoc([makeClip()]);
		const marker = createMarker({ sourceTimeSec: 5, createdAt: CREATED_AT });
		const once = bindMarkersToAsset(doc, ASSET, [marker]);
		const twice = bindMarkersToAsset(once, ASSET, [marker]);
		expect(twice.markers).toHaveLength(1);
	});

	it("is a no-op for an empty incoming list", () => {
		const doc = makeDoc([makeClip()]);
		expect(bindMarkersToAsset(doc, ASSET, [])).toBe(doc);
	});
});

describe("markersFromSession", () => {
	it("fills the gaps the wire shape allows", () => {
		const stored = markersFromSession(
			[
				{ id: "marker_a", sourceTimeSec: 7 },
				{ id: "marker_b", sourceTimeSec: 9, label: "retake" },
			],
			CREATED_AT,
		);
		expect(stored).toEqual([
			{ id: "marker_a", sourceTimeSec: 7, label: "", createdAt: CREATED_AT },
			{ id: "marker_b", sourceTimeSec: 9, label: "retake", createdAt: CREATED_AT },
		]);
	});

	it("produces markers the document schema accepts and the timeline can place", () => {
		const doc = makeDoc([makeClip()]);
		const next = bindMarkersToAsset(
			doc,
			ASSET,
			markersFromSession([{ id: "marker_a", sourceTimeSec: 12 }], CREATED_AT),
		);
		const parsed = documentSchema.parse(next);
		expect(visibleMarkers(parsed)).toEqual([{ marker: parsed.markers[0], rawTimeSec: 12 }]);
	});
});

describe("serialization", () => {
	it("round-trips markers through the document schema", () => {
		const doc = addMarker(makeDoc([makeClip()]), {
			assetId: ASSET,
			sourceTimeSec: 12.5,
			label: "retake",
			createdAt: CREATED_AT,
		});
		const parsed = documentSchema.parse(JSON.parse(JSON.stringify(doc)));
		expect(parsed.markers).toEqual(doc.markers);
	});

	it("opens a document written before markers existed, with an empty list", () => {
		// Exactly what an older build wrote: the key is simply absent. Destructured away
		// rather than `delete`d, which the document type rightly refuses to allow.
		const { markers: _dropped, ...legacy } = makeDoc([makeClip()]);
		const parsed = documentSchema.parse(legacy);
		expect(parsed.markers).toEqual([]);
	});

	it("keeps the document valid when a marker's asset is no longer in the project", () => {
		const doc = addMarker(makeDoc([makeClip()]), {
			assetId: "asset_gone",
			sourceTimeSec: 5,
			createdAt: CREATED_AT,
		});
		const parsed = documentSchema.parse(doc);
		expect(parsed.markers).toHaveLength(1);
		expect(visibleMarkers(parsed)).toEqual([]);
	});
});
