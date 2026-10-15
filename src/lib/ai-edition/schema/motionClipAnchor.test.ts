// The v5 clip anchor on the two Motion kinds.
//
// A motion region carries `{clipId, sourceStartSec, sourceEndSec}` on the same contract a
// zoom and an annotation do: the triple is the source of truth for which clip the move
// belongs to, and `startMs`/`endMs` are a DERIVED cache of it. Both kinds are read through a
// hand-written repairing parser rather than a zod object, and that parser used to return only
// `{id, startMs, endMs, timing, target}` — so `documentSchema.parse` silently dropped the
// anchor on every load, and a save→reopen forgot which media the move belonged to.
//
// These tests go through `documentSchema.parse`, not through `{...region}` spreads, because
// the spread is exactly what hid the loss: it preserves keys the parser never produced.
import { describe, expect, it } from "vitest";
import { parseCameraMotionRegion } from "@/lib/ai-edition/cameraMotion/parse";
import { documentSchema } from "@/lib/ai-edition/schema";
import { parseScreenMotionRegion } from "@/lib/ai-edition/screenMotion/parse";

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

/** A document shaped like a real project file: two clips, so an anchor has somewhere to point. */
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
				durationSec: 30,
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

const ANCHOR = { clipId: "clip_a", sourceStartSec: 1, sourceEndSec: 3 };

describe("motion clip anchor: survives a schema round-trip", () => {
	it("keeps the camera move's clipId / sourceStartSec / sourceEndSec", () => {
		const doc = makeDoc({
			cameraMotionRegions: [
				{
					id: "cammotion_a",
					startMs: 1000,
					endMs: 3000,
					...ANCHOR,
					timing: TIMING,
					target: CAM_TARGET,
				},
			],
		});
		const out = documentSchema.parse(doc);
		const region = out.cameraMotionRegions[0] as unknown as Record<string, unknown>;

		expect(region.clipId).toBe("clip_a");
		expect(region.sourceStartSec).toBe(1);
		expect(region.sourceEndSec).toBe(3);
		// And nothing else was invented alongside it.
		expect(region.id).toBe("cammotion_a");
		expect(region.startMs).toBe(1000);
		expect(region.endMs).toBe(3000);
	});

	it("keeps the screen move's clipId / sourceStartSec / sourceEndSec", () => {
		const doc = makeDoc({
			screenMotionRegions: [
				{
					id: "screenmotion_a",
					startMs: 1000,
					endMs: 3000,
					...ANCHOR,
					timing: TIMING,
					target: SCR_TARGET,
				},
			],
		});
		const out = documentSchema.parse(doc);
		const region = out.screenMotionRegions[0] as unknown as Record<string, unknown>;

		expect(region.clipId).toBe("clip_a");
		expect(region.sourceStartSec).toBe(1);
		expect(region.sourceEndSec).toBe(3);
	});

	it("round-trips through a save and a reopen unchanged", () => {
		const doc = makeDoc({
			cameraMotionRegions: [
				{
					id: "cammotion_a",
					startMs: 1000,
					endMs: 3000,
					...ANCHOR,
					timing: TIMING,
					target: CAM_TARGET,
				},
			],
			screenMotionRegions: [
				{
					id: "screenmotion_a",
					startMs: 1000,
					endMs: 3000,
					...ANCHOR,
					timing: TIMING,
					target: SCR_TARGET,
				},
			],
		});
		// save: what the writer serialises. load: what the reader parses back.
		const written = JSON.parse(JSON.stringify(documentSchema.parse(doc)));
		const read = documentSchema.parse(written);

		expect(read.cameraMotionRegions[0]).toEqual(written.cameraMotionRegions[0]);
		expect(read.screenMotionRegions[0]).toEqual(written.screenMotionRegions[0]);
		expect((read.cameraMotionRegions[0] as unknown as Record<string, unknown>).clipId).toBe(
			"clip_a",
		);
		expect((read.screenMotionRegions[0] as unknown as Record<string, unknown>).clipId).toBe(
			"clip_a",
		);
	});

	it("keeps the anchor on BOTH halves of a pill that spans two clips", () => {
		// The shape the paste work produces: two fragments of one pill, each anchored to its
		// own clip. Losing either anchor would leave that half pointing at whatever content
		// later slides under its derived `startMs`.
		const doc = makeDoc({
			cameraMotionRegions: [
				{
					id: "cammotion_f1",
					startMs: 0,
					endMs: 10000,
					clipId: "clip_a",
					sourceStartSec: 8,
					sourceEndSec: 10,
					timing: TIMING,
					target: CAM_TARGET,
				},
				{
					id: "cammotion_f2",
					startMs: 10000,
					endMs: 12000,
					clipId: "clip_b",
					sourceStartSec: 10,
					sourceEndSec: 12,
					timing: TIMING,
					target: CAM_TARGET,
				},
			],
		});
		const out = documentSchema.parse(doc);
		const [f1, f2] = out.cameraMotionRegions as unknown as Record<string, unknown>[];

		expect(f1.clipId).toBe("clip_a");
		expect(f1.sourceStartSec).toBe(8);
		expect(f2.clipId).toBe("clip_b");
		expect(f2.sourceStartSec).toBe(10);
		// Each half still holds its own identity and span.
		expect(f1.id).toBe("cammotion_f1");
		expect(f2.id).toBe("cammotion_f2");
		expect(f1.endMs).toBe(10000);
		expect(f2.endMs).toBe(12000);
	});
});

describe("motion clip anchor: a document without one still reads", () => {
	it("leaves an un-anchored camera move un-anchored", () => {
		const doc = makeDoc({
			cameraMotionRegions: [
				{ id: "cammotion_a", startMs: 1000, endMs: 3000, timing: TIMING, target: CAM_TARGET },
			],
		});
		const out = documentSchema.parse(doc);
		const region = out.cameraMotionRegions[0] as unknown as Record<string, unknown>;

		expect(region.id).toBe("cammotion_a");
		expect(region.startMs).toBe(1000);
		// Absent, NOT fabricated: an older document has no anchor, and inventing one would
		// re-home the move onto whichever clip its numbers happen to land on.
		expect("clipId" in region).toBe(false);
		expect("sourceStartSec" in region).toBe(false);
		expect("sourceEndSec" in region).toBe(false);
	});

	it("drops a HALF anchor rather than completing it", () => {
		// A clipId with no bounds addresses nothing; bounds with no clipId say which seconds
		// but not of what. Neither is a position, so neither is kept.
		const withIdOnly = parseCameraMotionRegion({
			id: "cammotion_x",
			startMs: 0,
			endMs: 1000,
			clipId: "clip_a",
			timing: TIMING,
			target: CAM_TARGET,
		}) as unknown as Record<string, unknown>;
		expect("clipId" in withIdOnly).toBe(false);

		const withBoundsOnly = parseScreenMotionRegion({
			id: "screenmotion_x",
			startMs: 0,
			endMs: 1000,
			sourceStartSec: 1,
			sourceEndSec: 2,
			timing: TIMING,
			target: SCR_TARGET,
		}) as unknown as Record<string, unknown>;
		expect("sourceStartSec" in withBoundsOnly).toBe(false);
		expect("sourceEndSec" in withBoundsOnly).toBe(false);
	});

	it("refuses a malformed anchor instead of repairing it into a wrong one", () => {
		const cases = [
			{ clipId: "", sourceStartSec: 1, sourceEndSec: 2 }, // empty id
			{ clipId: "clip_a", sourceStartSec: -1, sourceEndSec: 2 }, // negative
			{ clipId: "clip_a", sourceStartSec: "1", sourceEndSec: 2 }, // string bound
			{ clipId: "clip_a", sourceStartSec: Number.NaN, sourceEndSec: 2 }, // NaN
			{ clipId: 42, sourceStartSec: 1, sourceEndSec: 2 }, // non-string id
		];
		for (const anchor of cases) {
			const region = parseCameraMotionRegion({
				id: "cammotion_x",
				startMs: 0,
				endMs: 1000,
				...anchor,
				timing: TIMING,
				target: CAM_TARGET,
			}) as unknown as Record<string, unknown>;
			expect("clipId" in region).toBe(false);
			expect(region.startMs).toBe(0);
			expect(region.endMs).toBe(1000);
		}
	});

	it("trims a padded clipId rather than rejecting it", () => {
		const region = parseCameraMotionRegion({
			id: "cammotion_x",
			startMs: 0,
			endMs: 1000,
			clipId: "  clip_a  ",
			sourceStartSec: 1,
			sourceEndSec: 2,
			timing: TIMING,
			target: CAM_TARGET,
		}) as unknown as Record<string, unknown>;
		expect(region.clipId).toBe("clip_a");
	});
});

// A clip reorder must leave the move attached to its CONTENT. That is the whole point of the
// anchor: `startMs`/`endMs` are a cache of the ruler position, and a reorder rewrites it, so a
// move that carried no anchor would follow the ruler — landing on whatever content slid under
// those milliseconds.
describe("motion clip anchor: a clip reorder keeps the move on its content", () => {
	it("survives moveClip with the anchor intact and the ms cache recomputed", async () => {
		const { moveClip } = await import("@/lib/ai-edition/document/timeline");
		const doc = documentSchema.parse(
			makeDoc({
				cameraMotionRegions: [
					{
						id: "cammotion_a",
						startMs: 1000,
						endMs: 3000,
						clipId: "clip_a",
						sourceStartSec: 1,
						sourceEndSec: 3,
						timing: TIMING,
						target: CAM_TARGET,
					},
				],
			}),
		);

		// Swap the two clips: clip_b first, clip_a second.
		const reordered = moveClip(doc, "clip_b", 0);
		const region = reordered.cameraMotionRegions[0] as unknown as Record<string, unknown>;

		// The anchor is untouched — this is what keeps the move on clip_a's content.
		expect(region.clipId).toBe("clip_a");
		expect(region.sourceStartSec).toBe(1);
		expect(region.sourceEndSec).toBe(3);
		expect(region.id).toBe("cammotion_a");
	});

	it("still round-trips through save and reopen AFTER a reorder", async () => {
		const { moveClip } = await import("@/lib/ai-edition/document/timeline");
		const doc = documentSchema.parse(
			makeDoc({
				screenMotionRegions: [
					{
						id: "screenmotion_a",
						startMs: 1000,
						endMs: 3000,
						clipId: "clip_a",
						sourceStartSec: 1,
						sourceEndSec: 3,
						timing: TIMING,
						target: SCR_TARGET,
					},
				],
			}),
		);
		const reordered = moveClip(doc, "clip_b", 0);
		const written = JSON.parse(JSON.stringify(reordered));
		const read = documentSchema.parse(written);
		const region = read.screenMotionRegions[0] as unknown as Record<string, unknown>;

		expect(region.clipId).toBe("clip_a");
		expect(region.sourceStartSec).toBe(1);
		expect(region.sourceEndSec).toBe(3);
	});
});
