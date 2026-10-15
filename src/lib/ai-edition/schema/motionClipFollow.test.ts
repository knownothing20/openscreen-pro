// Camera / Screen Motion vs. STRUCTURAL clip edits.
//
// A motion region carries the v5 clip anchor, and `startMs`/`endMs` are a DERIVED cache of it:
// the ruler position the anchor resolves to. Every other anchored collection (zoom,
// annotation, audio) is walked by `mapAllRegionCollections` on every structural edit, so its
// cache is refreshed and a fragment whose clip disappeared is dropped. The two motion kinds
// were not in that walk — so a reorder left their `startMs`/`endMs` pointing at where the move
// USED to be, and the pill stayed behind on the ruler while its footage moved out from under it.
//
// The existing anchor tests only assert `clipId` / `sourceStartSec` / `sourceEndSec`, which stay
// correct throughout — that is exactly why they did not catch this. These tests assert the ms
// cache and the resolved timeline position.
import { describe, expect, it } from "vitest";
import {
	moveClip,
	rederiveRegionMs,
	removeClip,
	setClipSourceRange,
} from "@/lib/ai-edition/document/timeline";
import { type AxcutClip, documentSchema } from "@/lib/ai-edition/schema";
import { anchoredToRawSpanSec } from "@/lib/ai-edition/timeline/timelineMap";

const CAM_TARGET = {
	layout: "shape",
	shape: "square",
	position: { x: 0.5, y: 0.5 },
	size: 0.4,
	roundness: 0.3,
	opacity: 0.9,
};
const SCR_TARGET = {
	position: { x: 0.5, y: 0.5 },
	scale: 1.2,
	rotationX: 0,
	rotationY: 0,
	rotationZ: 0,
	perspective: 0.3,
};
const TIMING = { leadInSec: 0.5, returnSec: 0.5, easing: "linear" };

/** clip_a covers timeline 0–10s, clip_b covers 10–20s. */
function makeDoc(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 8,
		project: {
			id: "proj",
			title: "t",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			primaryAssetId: "asset_1",
		},
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "screen.mp4",
				originalPath: "/tmp/screen.mp4",
				durationSec: 60,
				video: { codec: "unknown", width: 1920, height: 1080, fps: 0 },
				cameraTrack: {
					sourcePath: "/tmp/camera.mp4",
					startMs: 0,
					offsetMs: 0,
					visible: true,
					width: 1280,
					height: 720,
				},
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [
				{
					id: "clip_a",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
				{
					id: "clip_b",
					assetId: "asset_1",
					sourceStartSec: 10,
					sourceEndSec: 20,
					timelineStartSec: 10,
					timelineEndSec: 20,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		audioTracks: [],
		markers: [],
		cameraMotionRegions: [],
		screenMotionRegions: [],
		legacyEditor: null,
		...overrides,
	};
}

const camMove = (id = "cammotion_a") => ({
	id,
	startMs: 1000,
	endMs: 3000,
	clipId: "clip_a",
	sourceStartSec: 1,
	sourceEndSec: 3,
	timing: TIMING,
	target: CAM_TARGET,
});
const scrMove = (id = "screenmotion_a") => ({
	id,
	startMs: 1000,
	endMs: 3000,
	clipId: "clip_a",
	sourceStartSec: 1,
	sourceEndSec: 3,
	timing: TIMING,
	target: SCR_TARGET,
});

const camOf = (doc: ReturnType<typeof documentSchema.parse>, id: string) =>
	doc.cameraMotionRegions.find((r) => r.id === id) as unknown as Record<string, unknown>;
const scrOf = (doc: ReturnType<typeof documentSchema.parse>, id: string) =>
	doc.screenMotionRegions.find((r) => r.id === id) as unknown as Record<string, unknown>;

/** Where the region's anchor resolves to on the CURRENT clip layout. */
const resolved = (doc: ReturnType<typeof documentSchema.parse>, region: Record<string, unknown>) =>
	anchoredToRawSpanSec(
		{
			clipId: region.clipId as string,
			sourceStartSec: region.sourceStartSec as number,
			sourceEndSec: region.sourceEndSec as number,
		},
		doc.timeline.clips,
	);

describe("4-A.2 reorder: camera motion follows its clip", () => {
	it("moves startMs/endMs to the clip's new ruler position", () => {
		const doc = documentSchema.parse(makeDoc({ cameraMotionRegions: [camMove()] }));
		// Sanity: before the reorder the cache agrees with the anchor.
		expect(camOf(doc, "cammotion_a").startMs).toBe(1000);
		expect(camOf(doc, "cammotion_a").endMs).toBe(3000);

		// Put clip_b first: clip_a now starts at 10s on the ruler.
		const reordered = moveClip(doc, "clip_b", 0);
		const region = camOf(reordered, "cammotion_a");

		// The anchor is the source of truth and must not have moved.
		expect(region.clipId).toBe("clip_a");
		expect(region.sourceStartSec).toBe(1);
		expect(region.sourceEndSec).toBe(3);

		// And the cache must follow it: 1s into clip_a is now 11s on the ruler.
		expect(region.startMs).toBe(11000);
		expect(region.endMs).toBe(13000);
	});

	it("agrees with what the timeline resolves the anchor to", () => {
		const doc = documentSchema.parse(makeDoc({ cameraMotionRegions: [camMove()] }));
		const reordered = moveClip(doc, "clip_b", 0);
		const region = camOf(reordered, "cammotion_a");
		const span = resolved(reordered, region);

		expect(span).not.toBeNull();
		expect(region.startMs).toBe(Math.round((span as { startSec: number }).startSec * 1000));
		expect(region.endMs).toBe(Math.round((span as { endSec: number }).endSec * 1000));
	});
});

describe("4-A.2 reorder: screen motion follows its clip", () => {
	it("moves startMs/endMs to the clip's new ruler position", () => {
		const doc = documentSchema.parse(makeDoc({ screenMotionRegions: [scrMove()] }));
		const reordered = moveClip(doc, "clip_b", 0);
		const region = scrOf(reordered, "screenmotion_a");

		expect(region.clipId).toBe("clip_a");
		expect(region.sourceStartSec).toBe(1);
		expect(region.sourceEndSec).toBe(3);
		expect(region.startMs).toBe(11000);
		expect(region.endMs).toBe(13000);
	});
});

describe("4-A.2: a reorder keeps the ms and the anchor consistent across a save", () => {
	it("round-trips the reordered document", () => {
		const doc = documentSchema.parse(makeDoc({ cameraMotionRegions: [camMove()] }));
		const reordered = moveClip(doc, "clip_b", 0);
		const read = documentSchema.parse(JSON.parse(JSON.stringify(reordered)));
		const region = camOf(read, "cammotion_a");

		expect(region.startMs).toBe(11000);
		expect(region.endMs).toBe(13000);
		expect(region.clipId).toBe("clip_a");
	});
});

describe("4-A.2: deleting the anchor's clip leaves no orphan", () => {
	it("drops the camera move whose clip is gone", () => {
		const doc = documentSchema.parse(makeDoc({ cameraMotionRegions: [camMove()] }));
		const without = removeClip(doc, "clip_a");

		expect(without.cameraMotionRegions).toHaveLength(0);
	});
});

describe("4-A.2: shortening a clip's source window clamps the move", () => {
	it("shortens the move to the surviving overlap", () => {
		const doc = documentSchema.parse(makeDoc({ cameraMotionRegions: [camMove()] }));
		// clip_a keeps source 0–2s, so the 1–3s move only has 1–2s of content left.
		const narrowed = setClipSourceRange(doc, "clip_a", 0, 2);
		const region = camOf(narrowed, "cammotion_a");

		expect(region.sourceStartSec).toBe(1);
		expect(region.sourceEndSec).toBe(2);
		expect(region.startMs).toBe(1000);
		expect(region.endMs).toBe(2000);
	});

	it("drops a move that falls entirely outside the new window", () => {
		const doc = documentSchema.parse(makeDoc({ cameraMotionRegions: [camMove()] }));
		// clip_a keeps source 5–10s: the 1–3s move has no content left at all.
		const narrowed = setClipSourceRange(doc, "clip_a", 5, 10);
		expect(narrowed.cameraMotionRegions).toHaveLength(0);
	});
});

describe("4-A.2: an un-anchored move keeps the RAW semantics", () => {
	it("leaves ms alone when there is no anchor to resolve", () => {
		const doc = documentSchema.parse(
			makeDoc({
				cameraMotionRegions: [
					{ id: "cammotion_raw", startMs: 1000, endMs: 3000, timing: TIMING, target: CAM_TARGET },
				],
			}),
		);
		const reordered = moveClip(doc, "clip_b", 0);
		const region = camOf(reordered, "cammotion_raw");

		// No anchor means no claim about which clip it belongs to, so it must not be
		// re-homed — and must not be dropped either.
		expect(region.startMs).toBe(1000);
		expect(region.endMs).toBe(3000);
		expect("clipId" in region).toBe(false);
	});
});

describe("4-A.2: rederiveRegionMs covers the motion collections", () => {
	it("is idempotent once the ms cache agrees with the anchor", () => {
		const doc = documentSchema.parse(makeDoc({ cameraMotionRegions: [camMove()] }));
		const once = rederiveRegionMs(doc, doc.timeline.clips);
		const twice = rederiveRegionMs(once, once.timeline.clips);
		expect(twice.cameraMotionRegions).toEqual(once.cameraMotionRegions);
	});
});

// A move that spans a clip BOUNDARY is stored as one fragment per covered clip. Each
// fragment carries its OWN anchor, so each must follow its own clip.
describe("4-A.2: a move spanning two clips follows both", () => {
	it("re-derives each fragment from its own clip after a reorder", () => {
		const doc = documentSchema.parse(
			makeDoc({
				cameraMotionRegions: [
					{
						id: "cammotion_f1",
						startMs: 9000,
						endMs: 10000,
						clipId: "clip_a",
						sourceStartSec: 9,
						sourceEndSec: 10,
						timing: TIMING,
						target: CAM_TARGET,
					},
					{
						id: "cammotion_f2",
						startMs: 10000,
						endMs: 11000,
						clipId: "clip_b",
						sourceStartSec: 10,
						sourceEndSec: 11,
						timing: TIMING,
						target: CAM_TARGET,
					},
				],
			}),
		);
		const reordered = moveClip(doc, "clip_b", 0);

		// clip_b is now first (0–10s) and clip_a second (10–20s).
		const f1 = camOf(reordered, "cammotion_f1");
		const f2 = camOf(reordered, "cammotion_f2");

		// f1 lives on clip_a, which moved to 10s: its 9–10s source lands at 19–20s.
		expect(f1.startMs).toBe(19000);
		expect(f1.endMs).toBe(20000);
		// f2 lives on clip_b, now at 0s: its 10–11s source lands at 0–1s.
		expect(f2.startMs).toBe(0);
		expect(f2.endMs).toBe(1000);
		// Both anchors untouched.
		expect(f1.clipId).toBe("clip_a");
		expect(f2.clipId).toBe("clip_b");
	});

	it("drops only the fragment whose clip was deleted", () => {
		const doc = documentSchema.parse(
			makeDoc({
				cameraMotionRegions: [
					{
						id: "cammotion_f1",
						startMs: 9000,
						endMs: 10000,
						clipId: "clip_a",
						sourceStartSec: 9,
						sourceEndSec: 10,
						timing: TIMING,
						target: CAM_TARGET,
					},
					{
						id: "cammotion_f2",
						startMs: 10000,
						endMs: 11000,
						clipId: "clip_b",
						sourceStartSec: 10,
						sourceEndSec: 11,
						timing: TIMING,
						target: CAM_TARGET,
					},
				],
			}),
		);
		const without = removeClip(doc, "clip_a");

		expect(without.cameraMotionRegions).toHaveLength(1);
		expect((without.cameraMotionRegions[0] as unknown as { id: string }).id).toBe("cammotion_f2");
	});
});

// The walk that gained the two motion collections is shared with zoom / annotation / audio.
// These pin the neighbours so a future change to the shared pipeline cannot quietly take them
// along.
describe("4-A.2: the neighbouring collections still behave", () => {
	// Shapes taken from the real schemas: `zoomRegionSchema` uses `depth` + `focus{cx,cy}`,
	// and `annotationRegionSchema` wants a `type` and a 0–100 `position`.
	const zoom = () => ({
		id: "zoom_a",
		startMs: 1000,
		endMs: 3000,
		clipId: "clip_a",
		sourceStartSec: 1,
		sourceEndSec: 3,
		depth: 3 as const,
		focus: { cx: 0.5, cy: 0.5 },
	});
	const annotation = () => ({
		id: "ann_a",
		startMs: 1000,
		endMs: 3000,
		clipId: "clip_a",
		sourceStartSec: 1,
		sourceEndSec: 3,
		type: "text" as const,
		content: "hi",
		position: { x: 50, y: 50 },
		size: { width: 30, height: 20 },
		style: {
			color: "#fff",
			backgroundColor: "transparent",
			fontSize: 32,
			fontFamily: "Inter",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			textAlign: "center",
			textAnimation: "none",
		},
		zIndex: 1,
	});

	it("zoom still follows a reorder", () => {
		const doc = documentSchema.parse(makeDoc({ zoomRanges: [zoom()] }));
		const reordered = moveClip(doc, "clip_b", 0);
		const z = reordered.zoomRanges[0] as unknown as Record<string, unknown>;
		expect(z.startMs).toBe(11000);
		expect(z.endMs).toBe(13000);
		expect(z.clipId).toBe("clip_a");
	});

	it("annotation still follows a reorder", () => {
		const doc = documentSchema.parse(makeDoc({ annotations: [annotation()] }));
		const reordered = moveClip(doc, "clip_b", 0);
		const a = reordered.annotations[0] as unknown as Record<string, unknown>;
		expect(a.startMs).toBe(11000);
		expect(a.endMs).toBe(13000);
	});

	it("zoom still drops when its clip is deleted", () => {
		const doc = documentSchema.parse(makeDoc({ zoomRanges: [zoom()] }));
		expect(removeClip(doc, "clip_a").zoomRanges).toHaveLength(0);
	});

	it("a camera move and a zoom on the same clip move together", () => {
		const doc = documentSchema.parse(
			makeDoc({ cameraMotionRegions: [camMove()], zoomRanges: [zoom()] }),
		);
		const reordered = moveClip(doc, "clip_b", 0);
		const c = camOf(reordered, "cammotion_a");
		const z = reordered.zoomRanges[0] as unknown as Record<string, unknown>;
		expect(c.startMs).toBe(z.startMs);
		expect(c.endMs).toBe(z.endMs);
	});
});

// When two indistinguishable neighbours fuse, one clip id stops existing. Anything anchored to
// it has to be re-homed onto the survivor — otherwise the move keeps naming a clip nothing
// can resolve, and the next re-derive drops it as an orphan.
describe("4-A.2: a clip merge re-homes the move onto the absorbing clip", () => {
	it("points the camera move at the clip that swallowed its own", async () => {
		const { withClipsChanged } = await import("@/lib/ai-edition/document/timeline");
		const base = makeDoc();
		const doc = documentSchema.parse(
			makeDoc({
				cameraMotionRegions: [
					{
						id: "cammotion_a",
						startMs: 11000,
						endMs: 13000,
						clipId: "clip_b",
						sourceStartSec: 11,
						sourceEndSec: 13,
						timing: TIMING,
						target: CAM_TARGET,
					},
				],
			}),
		);
		// clip_a and clip_b are same-asset and media-contiguous (0–10 then 10–20), so they fuse
		// into one clip; `clip_a` survives and `clip_b` is absorbed.
		const merged = withClipsChanged(doc, base.timeline.clips as AxcutClip[]);

		expect(merged.timeline.clips).toHaveLength(1);
		const region = camOf(merged, "cammotion_a");
		expect(region.clipId).toBe("clip_a");
		// Its source seconds are unchanged — only the id it names moved.
		expect(region.sourceStartSec).toBe(11);
		expect(region.sourceEndSec).toBe(13);
		// And the ms cache is re-derived against the merged layout.
		expect(region.startMs).toBe(11000);
		expect(region.endMs).toBe(13000);
	});

	it("leaves an un-anchored move alone through a merge", async () => {
		const { withClipsChanged } = await import("@/lib/ai-edition/document/timeline");
		const base = makeDoc();
		const doc = documentSchema.parse(
			makeDoc({
				cameraMotionRegions: [
					{ id: "cammotion_raw", startMs: 1000, endMs: 3000, timing: TIMING, target: CAM_TARGET },
				],
			}),
		);
		const merged = withClipsChanged(doc, base.timeline.clips as AxcutClip[]);
		const region = camOf(merged, "cammotion_raw");

		expect(region.startMs).toBe(1000);
		expect(region.endMs).toBe(3000);
		expect("clipId" in region).toBe(false);
	});
});
