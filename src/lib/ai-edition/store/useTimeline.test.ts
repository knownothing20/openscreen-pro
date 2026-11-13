// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import {
	defaultOpeningSequence,
	OPENING_CURVE_SWIFT,
	OPENING_ELEMENT_CAMERA,
	OPENING_ELEMENT_SCREEN,
	OPENING_ELEMENT_STICKERS,
	OPENING_PRESET_CONVERGE,
	OPENING_PRESET_SIDE_SLIDE,
} from "@/lib/ai-edition/opening/opening";
import { DEFAULT_TEXT_PLATE } from "../annotations/background";
import {
	CAMERA_MOTION_DEFAULT_TARGET,
	CAMERA_MOTION_FULLSCREEN_TARGET,
} from "../cameraMotion/presets";
import { type RegionKind, readSpeedRegions } from "../document/timeline";
import type { AxcutDocument } from "../schema";
import { axcutSchemaVersion, parseDocumentFile } from "../schema";
import {
	DEFAULT_SCREEN_MOTION_TIMING,
	SCREEN_MOTION_DEFAULT_TARGET,
} from "../screenMotion/presets";
import { appendAutoZoomSuggestions } from "../timeline/apply-auto-zooms";
import { ZOOM_SPOTLIGHT_DEFAULT } from "../timeline/zoomSpotlight";
import { useProjectStore } from "./projectStore";
import { clearHistory, redo, undo } from "./undo";
import { future, past } from "./undoStack";
import { useTimeline } from "./useTimeline";

/**
 * `useTimeline` reads the locale — `addAnnotation` seeds a new region with the
 * translated default text — so it needs the provider. One helper rather than a
 * wrapper argument on every call site.
 */
const renderTimeline = () => renderHook(() => useTimeline(), { wrapper: I18nProvider });

const probeVideoDurationMock = vi.hoisted(() => vi.fn());
const probeVideoDimensionsMock = vi.hoisted(() =>
	vi.fn().mockResolvedValue({ width: 1920, height: 1080 }),
);
const probeAudioDurationMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const toastErrorMock = vi.hoisted(() => vi.fn());
// Real implementation unless a test forces an answer (the backfill's timeout branch).
const waitForDocumentSavesMock = vi.hoisted(() => vi.fn());

vi.mock("./projectStore", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./projectStore")>();
	waitForDocumentSavesMock.mockImplementation(actual.waitForDocumentSaves);
	return { ...actual, waitForDocumentSaves: waitForDocumentSavesMock };
});

vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }));

vi.mock("../timeline/duration", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../timeline/duration")>();
	return {
		...actual,
		probeVideoDuration: probeVideoDurationMock,
		probeVideoDimensions: probeVideoDimensionsMock,
		probeAudioDuration: probeAudioDurationMock,
	};
});

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	addAsset: vi.fn(),
	removeAsset: vi.fn(),
	listProjects: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			get: bridgeMocks.get,
			create: bridgeMocks.create,
			save: bridgeMocks.save,
			addAsset: bridgeMocks.addAsset,
			removeAsset: bridgeMocks.removeAsset,
			listProjects: bridgeMocks.listProjects,
		},
	},
}));

const sampleDoc: AxcutDocument = {
	// ponytail: the bridge contract after the migration hoist is the CURRENT version —
	// every load site (DocumentService, browserShim) runs `migrateRawDocumentToCurrent`
	// before returning, and the renderer's `parseDocument` is a pure current-version
	// validator. Test fixtures model the post-hoist contract, so they read the version
	// off `axcutSchemaVersion` instead of restating it.
	// Annotated `AxcutDocument` rather than left to inference: the document type
	// pins `schemaVersion` to the LITERAL 7 and `kind` to `"video"`, both of which
	// an unannotated object literal widens — and the annotation makes every
	// required field (`cameraTrack`) a compile error when it is missing instead of
	// a fixture that silently drifts from the schema.
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "proj_test",
		title: "Test",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
		primaryAssetId: "asset_1",
	},
	assets: [
		{
			id: "asset_1",
			kind: "video",
			label: "screen.webm",
			originalPath: "/tmp/screen.webm",
			durationSec: 30,
			video: { codec: "unknown", width: 1920, height: 1080, fps: 0 },
			// No webcam was recorded alongside this screen capture.
			cameraTrack: null,
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
	opening: defaultOpeningSequence(),
	legacyEditor: null,
};

describe("useTimeline.insertClipAt background duration probe", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		probeVideoDurationMock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				assets: [
					...sampleDoc.assets,
					{
						id: "asset_2",
						kind: "video",
						label: "long.webm",
						originalPath: "/tmp/long.webm",
						durationSec: undefined,
						video: { codec: "unknown", width: 1920, height: 1080, fps: 0 },
						cameraTrack: null,
					},
				],
			},
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("only resizes the probed clip and leaves earlier clips' positions untouched", async () => {
		// clip_a already sits at 0..10 (a "short clip"). Insert a second clip
		// for asset_2 after it — insertClipAt has no cached duration for
		// asset_2, so it lands at the 60s placeholder, then the background
		// probe (mocked here to resolve to a much shorter real duration)
		// corrects it. Regression test for the bug where the probe used to
		// shift EVERY sibling clip (including ones before it) by the delta
		// between the real and placeholder duration, corrupting their
		// positions and producing visual overlap.
		probeVideoDurationMock.mockResolvedValue(5);
		const { result } = renderTimeline();

		await act(async () => {
			await result.current.insertClipAt("asset_2", 1);
		});

		const clips = useProjectStore.getState().document?.timeline.clips;
		expect(clips).toHaveLength(2);
		const clipA = clips?.find((c) => c.id === "clip_a");
		const inserted = clips?.find((c) => c.assetId === "asset_2");
		expect(clipA).toMatchObject({ timelineStartSec: 0, timelineEndSec: 10 });
		expect(inserted).toMatchObject({
			sourceEndSec: 5,
			timelineStartSec: 10,
			timelineEndSec: 15,
		});
	});
});

describe("useTimeline.setOpening — a preset is a patch, not a reset", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			// Deliberately not the defaults: if switching preset reset anything, a fixture that
			// already matched the defaults would hide it.
			document: {
				...sampleDoc,
				opening: {
					enabled: true,
					preset: OPENING_PRESET_SIDE_SLIDE,
					durationSec: 4,
					staggerSec: 0.5,
					curve: OPENING_CURVE_SWIFT,
					elementOrder: [OPENING_ELEMENT_CAMERA, OPENING_ELEMENT_SCREEN],
					includedElements: [OPENING_ELEMENT_SCREEN],
				},
			},
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("changes only the preset", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.setOpening({ preset: OPENING_PRESET_CONVERGE });
		});

		const after = useProjectStore.getState().document?.opening;
		expect(after?.preset).toBe(OPENING_PRESET_CONVERGE);
		// Everything the preset does not own is untouched — the whole point of keeping duration,
		// stagger, selection and order out of it.
		expect(after?.enabled).toBe(true);
		expect(after?.durationSec).toBe(4);
		expect(after?.staggerSec).toBe(0.5);
		expect(after?.curve).toBe(OPENING_CURVE_SWIFT);
		expect(after?.elementOrder).toEqual([
			OPENING_ELEMENT_CAMERA,
			OPENING_ELEMENT_SCREEN,
			OPENING_ELEMENT_STICKERS,
		]);
		expect(after?.includedElements).toEqual([OPENING_ELEMENT_SCREEN]);
	});

	it("switches back, and the second switch is not affected by the first", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.setOpening({ preset: OPENING_PRESET_CONVERGE });
		});
		await act(async () => {
			await result.current.setOpening({ preset: OPENING_PRESET_SIDE_SLIDE });
		});
		const after = useProjectStore.getState().document?.opening;
		expect(after?.preset).toBe(OPENING_PRESET_SIDE_SLIDE);
		expect(after?.durationSec).toBe(4);
	});

	it("writes one save per switch, so a switch is one undo step", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.setOpening({ preset: OPENING_PRESET_CONVERGE });
		});
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
	});
});

describe("useTimeline.moveClip / duplicateClip (delegates to document/timeline.ts)", () => {
	const twoClipDoc: AxcutDocument = {
		...sampleDoc,
		timeline: {
			...sampleDoc.timeline,
			clips: [
				sampleDoc.timeline.clips[0],
				{
					id: "clip_b",
					assetId: "asset_1",
					// Does not continue where clip_a stops, on purpose: two clips of one recording
					// whose media timecodes meet are one clip, so a fixture like that would
					// collapse under any structural edit.
					sourceStartSec: 15,
					sourceEndSec: 25,
					timelineStartSec: 10,
					timelineEndSec: 20,
					wordRefs: [],
					origin: "user" as const,
					reason: "",
				},
			],
		},
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: twoClipDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("moveClip reorders clips and persists the resequenced timeline", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.moveClip("clip_a", 1);
		});
		const clips = useProjectStore.getState().document?.timeline.clips;
		expect(clips?.map((c) => c.id)).toEqual(["clip_b", "clip_a"]);
		expect(clips?.[0]).toMatchObject({ timelineStartSec: 0, timelineEndSec: 10 });
		expect(clips?.[1]).toMatchObject({ timelineStartSec: 10, timelineEndSec: 20 });
	});

	it("moveClip no-ops for an unknown clip id", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.moveClip("clip_missing", 0);
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});

	it("moveClip no-ops when the clip is dropped where it already sits", async () => {
		// `toIndex` counts insert positions in the list WITHOUT the dragged clip, so index 0
		// is exactly where clip_a already is. Recorded as an undo step, it would make the next
		// Ctrl+Z appear to do nothing. (Index 1 is a genuine move down by one, so it is not
		// part of this case — the reorder test below covers it.)
		const { result } = renderTimeline();
		const stepsBefore = past.length;
		await act(async () => {
			await result.current.moveClip("clip_a", 0);
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(past).toHaveLength(stepsBefore);
		expect(useProjectStore.getState().document?.timeline.clips.map((c) => c.id)).toEqual([
			"clip_a",
			"clip_b",
		]);
	});

	it("keeps each clip's own hard cut through a reorder, and one undo puts the order back", async () => {
		// A hard cut is a property of the clip it sits on ("do not blend into what follows"),
		// so it must travel WITH that clip rather than stay at the position it used to occupy.
		const clipped: AxcutDocument = {
			...twoClipDoc,
			timeline: {
				...twoClipDoc.timeline,
				clips: twoClipDoc.timeline.clips.map((c) =>
					c.id === "clip_a" ? { ...c, hardCutAfter: true } : c,
				),
			},
		};
		useProjectStore.setState({ document: clipped });
		const { result } = renderTimeline();
		const stepsBefore = past.length;

		await act(async () => {
			await result.current.moveClip("clip_a", 1);
		});

		const clips = useProjectStore.getState().document?.timeline.clips ?? [];
		expect(clips.map((c) => c.id)).toEqual(["clip_b", "clip_a"]);
		expect(clips.find((c) => c.id === "clip_a")?.hardCutAfter).toBe(true);
		expect(clips.find((c) => c.id === "clip_b")?.hardCutAfter).toBeUndefined();
		// The timeline is resequenced, not just reordered: no gap, no overlap.
		expect(clips[0].timelineStartSec).toBe(0);
		expect(clips[1].timelineStartSec).toBe(clips[0].timelineEndSec);
		// Source ranges are the clip's own and do not move with the position.
		expect(clips.find((c) => c.id === "clip_b")).toMatchObject({
			sourceStartSec: 15,
			sourceEndSec: 25,
		});
		expect(past).toHaveLength(stepsBefore + 1);

		act(() => {
			undo();
		});
		expect(useProjectStore.getState().document?.timeline.clips.map((c) => c.id)).toEqual([
			"clip_a",
			"clip_b",
		]);
	});

	it("duplicateClip inserts a copy right after the original and selects it", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.duplicateClip("clip_a");
		});
		const clips = useProjectStore.getState().document?.timeline.clips;
		expect(clips).toHaveLength(3);
		expect(clips?.[0].id).toBe("clip_a");
		expect(clips?.[2].id).toBe("clip_b");
		const copyId = clips?.[1].id;
		expect(copyId).toBeTruthy();
		expect(copyId).not.toBe("clip_a");
		expect(result.current.clipSelection).toBe(copyId);
	});

	it("duplicateClip no-ops for an unknown clip id", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.duplicateClip("clip_missing");
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});
});

describe("useTimeline backfills missing source dimensions on load", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		probeVideoDimensionsMock.mockReset();
		probeVideoDimensionsMock.mockResolvedValue({ width: 1920, height: 1080 });
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// The reported bug: a project saved with a duration but no probed `video` dims (nothing
	// re-probes it on open) drops that clip from everything reading asset.video — the ratio
	// picker's ORIGINAL list, the output resolution, the export badges.
	it("probes a used asset that has a duration but no video dims, and persists them", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				assets: [{ ...sampleDoc.assets[0], video: undefined }],
			},
			revision: 1,
			status: "ready",
			error: null,
		});
		renderTimeline();
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1);
		const saved = useProjectStore.getState().document?.assets.find((a) => a.id === "asset_1");
		expect(saved?.video).toMatchObject({ width: 1920, height: 1080 });
	});

	// A fresh recording: the document is rewritten (duration, camera link, auto-zoom) while
	// the probe is still out. That re-render used to cancel the probe's write for good.
	it("still persists probed dims when the document changes while the probe is running", async () => {
		let resolveProbe!: (dims: { width: number; height: number }) => void;
		probeVideoDimensionsMock.mockReturnValue(
			new Promise((resolve) => {
				resolveProbe = resolve;
			}),
		);
		const unprobed = { ...sampleDoc, assets: [{ ...sampleDoc.assets[0], video: undefined }] };
		useProjectStore.setState({
			projectId: "proj_test",
			document: unprobed,
			revision: 1,
			status: "ready",
			error: null,
		});
		renderTimeline();
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1));
		act(() => {
			useProjectStore.setState({ document: { ...unprobed, zoomRanges: [] }, revision: 2 });
		});
		await act(async () => {
			resolveProbe({ width: 1080, height: 1920 });
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		const saved = useProjectStore.getState().document?.assets.find((a) => a.id === "asset_1");
		expect(saved?.video).toMatchObject({ width: 1080, height: 1920 });
	});

	// The fresh-recording auto-zooms are saved while the probe is out. The store only takes
	// them once that save returns, so a backfill built on the store before then erased them.
	it("keeps a save that is still in flight when the probe resolves", async () => {
		let resolveProbe!: (dims: { width: number; height: number }) => void;
		probeVideoDimensionsMock.mockReturnValue(
			new Promise((resolve) => {
				resolveProbe = resolve;
			}),
		);
		const unprobed = { ...sampleDoc, assets: [{ ...sampleDoc.assets[0], video: undefined }] };
		useProjectStore.setState({
			projectId: "proj_test",
			document: unprobed,
			revision: 1,
			status: "ready",
			error: null,
		});
		renderTimeline();
		await waitFor(() => expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1));

		let releaseZoomSave!: () => void;
		const zoomSaveGate = new Promise<void>((resolve) => {
			releaseZoomSave = resolve;
		});
		bridgeMocks.save.mockImplementationOnce(async (doc: typeof sampleDoc) => {
			await zoomSaveGate;
			return { success: true, document: doc };
		});
		const zoomed = {
			...unprobed,
			zoomRanges: [
				{ id: "zoom_1", startMs: 0, endMs: 1000, depth: 3, focus: { cx: 0.5, cy: 0.5 } },
			],
		} as AxcutDocument;
		let zoomSave!: Promise<boolean>;
		act(() => {
			zoomSave = useProjectStore.getState().saveDocument(zoomed, { history: true });
		});
		await act(async () => {
			resolveProbe({ width: 1080, height: 1920 });
			await new Promise((r) => setTimeout(r, 0));
		});
		await act(async () => {
			releaseZoomSave();
			await zoomSave;
		});

		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(2));
		await waitFor(() => {
			const doc = useProjectStore.getState().document;
			expect(doc?.zoomRanges).toHaveLength(1);
			expect(doc?.assets.find((a) => a.id === "asset_1")?.video).toMatchObject({
				width: 1080,
				height: 1920,
			});
		});
	});

	// A wait that times out says nothing about what landed, so the backfill writes nothing.
	// It must not leave the asset marked attempted either, or no later run ever probes it.
	it("probes again on the next document change after the save wait timed out", async () => {
		waitForDocumentSavesMock.mockResolvedValueOnce("timeout");
		const unprobed = { ...sampleDoc, assets: [{ ...sampleDoc.assets[0], video: undefined }] };
		useProjectStore.setState({
			projectId: "proj_test",
			document: unprobed,
			revision: 1,
			status: "ready",
			error: null,
		});
		renderTimeline();
		await waitFor(() => expect(waitForDocumentSavesMock).toHaveBeenCalledTimes(1));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();

		act(() => {
			useProjectStore.setState({ document: { ...unprobed, zoomRanges: [] }, revision: 2 });
		});
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(2);
		const saved = useProjectStore.getState().document?.assets.find((a) => a.id === "asset_1");
		expect(saved?.video).toMatchObject({ width: 1920, height: 1080 });
	});

	it("leaves an asset that already has video dims untouched", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc, // asset_1 already carries 1920x1080
			revision: 1,
			status: "ready",
			error: null,
		});
		renderTimeline();
		// Give any stray effect a chance to fire before asserting it didn't.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(probeVideoDimensionsMock).not.toHaveBeenCalled();
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});

	it("does not re-probe a used asset with no reachable file more than once", async () => {
		probeVideoDimensionsMock.mockResolvedValue(null); // probe fails (unreadable file)
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				assets: [{ ...sampleDoc.assets[0], video: undefined }],
			},
			revision: 1,
			status: "ready",
			error: null,
		});
		const { rerender } = renderTimeline();
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		rerender();
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		// Attempted once; the failure is remembered so a document change doesn't spin it again.
		expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});
});

describe("useTimeline.applyClipEdit (Edit-clip modal)", () => {
	const anchoredZoom = (id: string, s: number, e: number) => ({
		id,
		startMs: s * 1000,
		endMs: e * 1000,
		clipId: "clip_a",
		sourceStartSec: s,
		sourceEndSec: e,
		depth: 3 as const,
		focus: { cx: 0.5, cy: 0.5 },
	});

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				zoomRanges: [anchoredZoom("z_keep", 2, 3), anchoredZoom("z_drop", 6, 8)],
			},
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("shrinks the clip's timeline width to match the narrowed source window", async () => {
		const { result } = renderTimeline();
		// Trim the 10s clip down to its first 4s of source.
		await act(async () => {
			await result.current.applyClipEdit("clip_a", 0, 4);
		});
		const clip = useProjectStore.getState().document?.timeline.clips[0];
		expect(clip).toMatchObject({ sourceStartSec: 0, sourceEndSec: 4 });
		// The width followed the edit instead of keeping its stale 10s extent.
		expect(clip?.timelineStartSec).toBe(0);
		expect(clip?.timelineEndSec).toBe(4);
	});

	it("drops a pill sitting over the truncated tail and keeps the one that survives", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.applyClipEdit("clip_a", 0, 4);
		});
		const zooms = useProjectStore.getState().document?.zoomRanges ?? [];
		// z_keep (source 2-3) stays; z_drop (source 6-8) is entirely past the new 4s end.
		expect(zooms.map((z) => z.id)).toEqual(["z_keep"]);
		expect(zooms[0]).toMatchObject({
			sourceStartSec: 2,
			sourceEndSec: 3,
			startMs: 2000,
			endMs: 3000,
		});
	});

	it("shortens a pill that straddles the new clip end to the surviving overlap", async () => {
		useProjectStore.setState({
			document: {
				...sampleDoc,
				zoomRanges: [anchoredZoom("z_edge", 3, 7)],
			},
		});
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.applyClipEdit("clip_a", 0, 5);
		});
		const zooms = useProjectStore.getState().document?.zoomRanges ?? [];
		expect(zooms).toHaveLength(1);
		// 3-7 clamped to the [0,5] window → 3-5.
		expect(zooms[0]).toMatchObject({
			sourceStartSec: 3,
			sourceEndSec: 5,
			startMs: 3000,
			endMs: 5000,
		});
	});

	// #355. Apply used to fire `updateClipSourceRange` and `updateClipCrop` as two
	// concurrent saves, each built from the same pre-Apply document — so the second
	// write clobbered the first and one of the two edits vanished with no error and no
	// toast. Which one survived depended on IPC timing, which is why it read as "the app
	// randomly forgets my crop".
	it("keeps BOTH the source range and the crop when Apply changes them together", async () => {
		const { result } = renderTimeline();
		const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };
		await act(async () => {
			await result.current.applyClipEdit("clip_a", 0, 4, crop);
		});
		const clip = useProjectStore.getState().document?.timeline.clips[0];
		expect(clip).toMatchObject({ sourceStartSec: 0, sourceEndSec: 4, cropRegion: crop });
		// The width still followed the range edit — the crop is applied to the
		// RESEQUENCED clips, not to a stale copy of them.
		expect(clip?.timelineEndSec).toBe(4);
		// One user action, one document, one write: two saves is the race itself.
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
	});

	it("clears the crop on an explicit null and leaves it alone on undefined", async () => {
		useProjectStore.setState({
			document: {
				...sampleDoc,
				timeline: {
					...sampleDoc.timeline,
					clips: [
						{ ...sampleDoc.timeline.clips[0], cropRegion: { x: 0, y: 0, width: 0.5, height: 1 } },
					],
				},
			},
		});
		const { result } = renderTimeline();
		// `undefined` is the modal's "crop section untouched" — the stored region stays.
		await act(async () => {
			await result.current.applyClipEdit("clip_a", 0, 6);
		});
		expect(useProjectStore.getState().document?.timeline.clips[0].cropRegion).toEqual({
			x: 0,
			y: 0,
			width: 0.5,
			height: 1,
		});
		// `null` is "reset to no crop", stored as an absent field rather than the
		// identity region.
		await act(async () => {
			await result.current.applyClipEdit("clip_a", 0, 6, null);
		});
		expect(useProjectStore.getState().document?.timeline.clips[0].cropRegion).toBeUndefined();
	});
});

// #353. The toolbar button and the `C` shortcut both used to write a region on a
// project with no webcam: it persists into `legacyEditor.cameraFullscreenRegions`,
// renders nothing in the preview (PreviewCanvas short-circuits on a missing
// `webcamRect`) and nothing in the export, forever, with no feedback. The gate lives
// in the shared mutation so both entry points — and any future one — are covered.
describe("useTimeline.addCameraFullscreen (camera gate)", () => {
	const cameraAsset = {
		...sampleDoc.assets[0],
		cameraTrack: {
			sourcePath: "/tmp/camera.webm",
			startMs: 0,
			offsetMs: 0,
			visible: true,
			// Dimensions filled in so the hook's backfill probe has nothing to do — an
			// unprobed camera would fire its own `saveDocument` alongside this test's.
			width: 1280,
			height: 720,
		},
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			currentTimeSec: 1,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("writes nothing when no clip on the timeline has a camera", async () => {
		// sampleDoc's only asset carries `cameraTrack: null`.
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addCameraFullscreen();
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.legacyEditor).toBeNull();
		expect(result.current.cameraFullscreenRegions).toEqual([]);
	});

	it("still writes a region when a clip's asset carries a camera", async () => {
		useProjectStore.setState({ document: { ...sampleDoc, assets: [cameraAsset] } });
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addCameraFullscreen();
		});
		const legacy = useProjectStore.getState().document?.legacyEditor as Record<string, unknown>;
		const regions = legacy.cameraFullscreenRegions as Array<{ startMs: number; endMs: number }>;
		expect(regions).toHaveLength(1);
		// 2s at the playhead (currentTimeSec = 1), the shared default.
		expect(regions[0]).toMatchObject({ startMs: 1000, endMs: 3000 });
	});
});

// A camera move is its own document field with its own schema — not a span on
// `legacyEditor` — so the calls that create, move and delete one are pinned here. The C
// shortcut calls `addCameraMotion()` with no arguments, which is why that bare call is
// the first case: it IS the shortcut's behaviour. The legacy `addCameraFullscreen` suite
// above keeps its own, and the two must not converge.
describe("useTimeline camera motion regions", () => {
	const cameraAsset = {
		...sampleDoc.assets[0],
		cameraTrack: {
			sourcePath: "/tmp/camera.webm",
			startMs: 0,
			offsetMs: 0,
			visible: true,
			// Dimensions filled in so the hook's backfill probe has nothing to do — an
			// unprobed camera would fire its own `saveDocument` alongside this test's.
			width: 1280,
			height: 720,
		},
	};

	const motionRegions = () => useProjectStore.getState().document?.cameraMotionRegions ?? [];

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: { ...sampleDoc, assets: [cameraAsset] },
			currentTimeSec: 1,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("the bare call the C shortcut makes creates a fullscreen move, not a legacy span", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addCameraMotion();
		});

		const regions = motionRegions();
		expect(regions).toHaveLength(1);
		// 2s at the playhead (currentTimeSec = 1), the shared default.
		expect(regions[0]).toMatchObject({ startMs: 1000, endMs: 3000 });
		expect(regions[0].target).toEqual(CAMERA_MOTION_FULLSCREEN_TARGET);
		// It went to the camera motion field, and nothing to the legacy envelope.
		expect(useProjectStore.getState().document?.legacyEditor).toBeNull();
	});

	it("takes an explicit duration and target", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addCameraMotion(5, CAMERA_MOTION_DEFAULT_TARGET);
		});

		const regions = motionRegions();
		expect(regions).toHaveLength(1);
		expect(regions[0]).toMatchObject({ startMs: 1000, endMs: 6000 });
		expect(regions[0].target).toEqual(CAMERA_MOTION_DEFAULT_TARGET);
	});

	it("writes nothing when no clip's asset carries a camera", async () => {
		// sampleDoc's only asset carries `cameraTrack: null`.
		useProjectStore.setState({ document: sampleDoc });
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addCameraMotion();
		});

		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(motionRegions()).toEqual([]);
	});

	it("deletes only the region it names", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addCameraMotion();
		});
		await act(async () => {
			await result.current.addCameraMotion(1);
		});
		const [first, second] = motionRegions();
		expect(motionRegions()).toHaveLength(2);

		await act(async () => {
			await result.current.removeCameraMotion(first.id);
		});

		const left = motionRegions();
		expect(left).toHaveLength(1);
		expect(left[0].id).toBe(second.id);
	});

	// The camera half of the shared live/commit pair: the same guarantee, on the other kind,
	// through the same `commitMotionTarget`.
	it("records one undo step for a whole slider drag, not one per value", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addCameraMotion();
		});
		const id = motionRegions()[0].id;
		const stepsBefore = past.length;

		await act(async () => {
			for (const value of [10, 20, 30]) {
				result.current.setCameraMotionTargetLive(id, { size: value / 100 });
			}
		});
		expect(motionRegions()[0].target.size).toBeCloseTo(0.3, 6);
		expect(past).toHaveLength(stepsBefore);

		await act(async () => {
			await result.current.commitMotionTarget();
		});
		expect(past).toHaveLength(stepsBefore + 1);

		await act(async () => {
			expect(undo()).toBe(true);
		});
		expect(motionRegions()[0].target.size).toBe(CAMERA_MOTION_FULLSCREEN_TARGET.size);
	});

	it("records a creation as one undoable edit", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addCameraMotion();
		});
		expect(motionRegions()).toHaveLength(1);

		await act(async () => {
			expect(undo()).toBe(true);
		});
		expect(motionRegions()).toHaveLength(0);

		await act(async () => {
			expect(redo()).toBe(true);
		});
		expect(motionRegions()).toHaveLength(1);
	});

	it("records a deletion as one undoable edit", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addCameraMotion();
		});
		const id = motionRegions()[0].id;

		await act(async () => {
			await result.current.removeCameraMotion(id);
		});
		expect(motionRegions()).toHaveLength(0);

		await act(async () => {
			expect(undo()).toBe(true);
		});
		expect(motionRegions()).toHaveLength(1);
		expect(motionRegions()[0].id).toBe(id);
	});
});

describe("useTimeline screen motion regions", () => {
	const screenRegions = () => useProjectStore.getState().document?.screenMotionRegions ?? [];

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			currentTimeSec: 1,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("the bare call the N shortcut makes lands a move with the default target and timing", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addScreenMotion();
		});

		const regions = screenRegions();
		expect(regions).toHaveLength(1);
		// 2s at the playhead (currentTimeSec = 1), the shared default.
		expect(regions[0]).toMatchObject({ startMs: 1000, endMs: 3000 });
		expect(regions[0].target).toEqual(SCREEN_MOTION_DEFAULT_TARGET);
		expect(regions[0].timing).toEqual(DEFAULT_SCREEN_MOTION_TIMING);
		// The new field, not the legacy envelope — and not the camera's either.
		expect(useProjectStore.getState().document?.legacyEditor).toBeNull();
		expect(useProjectStore.getState().document?.cameraMotionRegions).toEqual([]);
	});

	it("takes an explicit duration and target", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addScreenMotion(5, {
				...SCREEN_MOTION_DEFAULT_TARGET,
				scale: 2.5,
			});
		});

		const regions = screenRegions();
		expect(regions).toHaveLength(1);
		expect(regions[0]).toMatchObject({ startMs: 1000, endMs: 6000 });
		expect(regions[0].target.scale).toBe(2.5);
	});

	// The deliberate asymmetry with Camera Motion: a camera move refuses to be created
	// without a camera (#353), a screen move never has to — every project has a screen.
	// `sampleDoc`'s only asset carries `cameraTrack: null`, so this is the no-camera case.
	it("creates a move in a project with no camera, where a camera move would refuse", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addScreenMotion();
		});

		expect(screenRegions()).toHaveLength(1);
		// And the camera's own gate still holds, so the two rules are not the same rule.
		await act(async () => {
			await result.current.addCameraMotion();
		});
		expect(useProjectStore.getState().document?.cameraMotionRegions).toEqual([]);
	});

	it("moves the span without touching the target", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addScreenMotion();
		});
		const id = screenRegions()[0].id;

		await act(async () => {
			await result.current.updateScreenMotionSpan(id, 4000, 7000);
		});

		const [region] = screenRegions();
		expect(region).toMatchObject({ id, startMs: 4000, endMs: 7000 });
		expect(region.target).toEqual(SCREEN_MOTION_DEFAULT_TARGET);
	});

	it("deletes only the region it names", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addScreenMotion();
		});
		await act(async () => {
			await result.current.addScreenMotion(1);
		});
		const [first, second] = screenRegions();
		expect(screenRegions()).toHaveLength(2);

		await act(async () => {
			await result.current.removeScreenMotion(first.id);
		});

		const left = screenRegions();
		expect(left).toHaveLength(1);
		expect(left[0].id).toBe(second.id);
	});

	it("patches one target field and leaves the others where they were", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addScreenMotion();
		});
		const id = screenRegions()[0].id;

		await act(async () => {
			await result.current.setScreenMotionTarget(id, { rotationY: 30 });
		});

		const [region] = screenRegions();
		expect(region.target.rotationY).toBe(30);
		// Everything the patch did not mention is untouched — the Inspector sends one control
		// at a time, so a rebuild would silently reset the rest.
		expect(region.target.scale).toBe(SCREEN_MOTION_DEFAULT_TARGET.scale);
		expect(region.target.position).toEqual(SCREEN_MOTION_DEFAULT_TARGET.position);
		expect(region.target.rotationX).toBe(SCREEN_MOTION_DEFAULT_TARGET.rotationX);
	});

	it("patches one timing field and leaves the others where they were", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addScreenMotion();
		});
		const id = screenRegions()[0].id;

		await act(async () => {
			await result.current.setScreenMotionTiming(id, { easing: "linear" });
		});

		const [region] = screenRegions();
		expect(region.timing.easing).toBe("linear");
		expect(region.timing.leadInSec).toBe(DEFAULT_SCREEN_MOTION_TIMING.leadInSec);
		expect(region.timing.returnSec).toBe(DEFAULT_SCREEN_MOTION_TIMING.returnSec);
	});

	it("records one undo step for a whole slider drag, not one per value", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addScreenMotion();
		});
		const id = screenRegions()[0].id;
		const stepsBefore = past.length;

		// What a drag does: a live write for every value the pointer passes through...
		await act(async () => {
			for (const value of [10, 20, 30]) {
				result.current.setScreenMotionTargetLive(id, { rotationY: value });
			}
		});
		expect(screenRegions()[0].target.rotationY).toBe(30);
		// ...and none of them on the undo stack.
		expect(past).toHaveLength(stepsBefore);

		// Then one commit on release.
		await act(async () => {
			await result.current.commitMotionTarget();
		});
		expect(past).toHaveLength(stepsBefore + 1);

		// One Ctrl+Z returns to the value the drag started on, not to one it passed through a
		// millisecond earlier.
		await act(async () => {
			expect(undo()).toBe(true);
		});
		expect(screenRegions()[0].target.rotationY).toBe(SCREEN_MOTION_DEFAULT_TARGET.rotationY);
	});

	it("records a creation as one undoable edit", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addScreenMotion();
		});
		expect(screenRegions()).toHaveLength(1);

		await act(async () => {
			expect(undo()).toBe(true);
		});
		expect(screenRegions()).toHaveLength(0);

		await act(async () => {
			expect(redo()).toBe(true);
		});
		expect(screenRegions()).toHaveLength(1);
	});

	it("records a deletion as one undoable edit", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addScreenMotion();
		});
		const id = screenRegions()[0].id;

		await act(async () => {
			await result.current.removeScreenMotion(id);
		});
		expect(screenRegions()).toHaveLength(0);

		await act(async () => {
			expect(undo()).toBe(true);
		});
		expect(screenRegions()).toHaveLength(1);
		expect(screenRegions()[0].id).toBe(id);
	});
});

describe("useTimeline.addAnnotation", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			currentTimeSec: 1,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("creates a text annotation carrying the localised default text", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addAnnotation();
		});
		const annotations = useProjectStore.getState().document?.annotations ?? [];
		expect(annotations).toHaveLength(1);
		// Real text, not an empty field. An empty annotation renders nothing at
		// all, so adding one used to change nothing on the canvas; the
		// inspector's placeholder is CSS ghost text that never reaches `content`
		// and therefore never reached the compositor. DEFAULT_LOCALE is `en`.
		expect(annotations[0]).toMatchObject({ type: "text", content: "Hello" });
		// Still auto-selected, so its inspector opens ready to be typed over.
		expect(result.current.selection).toEqual({
			kind: "annotation",
			id: (annotations[0] as { id: string }).id,
		});
	});

	it("centres the new text box and puts it on a dark plate that reads on any page", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addAnnotation();
		});
		const [annotation] = useProjectStore.getState().document?.annotations ?? [];
		const { position, size } = annotation as {
			position: { x: number; y: number };
			size: { width: number; height: number };
		};
		expect([position.x + size.width / 2, position.y + size.height / 2]).toEqual([50, 50]);
		expect(annotation.style.backgroundColor).toBe(DEFAULT_TEXT_PLATE);
	});
});

// The Clear timeline button. Every edit region on every clip, one write; the content stays.
describe("useTimeline.clearTimeline", () => {
	type Timeline = ReturnType<typeof useTimeline>;
	type EditKind = Exclude<RegionKind, "audio">;

	// A Record rather than a list: a new region kind fails to compile here until this suite
	// decides whether "Clear timeline" takes it. Each adder goes through the real hook, so
	// every region is schema-valid by construction.
	const addOf: Record<EditKind, (tl: Timeline) => Promise<unknown>> = {
		zoom: (tl) => tl.addZoom(),
		trim: (tl) => tl.addTrim(),
		annotation: (tl) => tl.addAnnotation(),
		speed: (tl) => tl.addSpeed(),
		cameraFullscreen: (tl) => tl.addCameraFullscreen(),
		cameraMotion: (tl) => tl.addCameraMotion(),
		screenMotion: (tl) => tl.addScreenMotion(),
	};
	const editKinds = Object.keys(addOf) as EditKind[];

	const regionCounts = (doc: AxcutDocument | null | undefined): Record<EditKind, number> => {
		const legacy = (doc?.legacyEditor ?? {}) as { cameraFullscreenRegions?: unknown[] };
		return {
			zoom: doc?.zoomRanges.length ?? 0,
			trim: doc?.timeline.trimRanges.length ?? 0,
			annotation: doc?.annotations.length ?? 0,
			speed: doc ? readSpeedRegions(doc).length : 0,
			cameraFullscreen: legacy.cameraFullscreenRegions?.length ?? 0,
			cameraMotion: doc?.cameraMotionRegions.length ?? 0,
			screenMotion: doc?.screenMotionRegions.length ?? 0,
		};
	};
	const noRegions: Record<EditKind, number> = {
		zoom: 0,
		trim: 0,
		annotation: 0,
		speed: 0,
		cameraFullscreen: 0,
		cameraMotion: 0,
		screenMotion: 0,
	};

	// A project holding everything that is NOT an edit: two clips, a webcam, an imported
	// audio track, a transcript, captions, a pause, and settings in the legacy envelope.
	const clipA = sampleDoc.timeline.clips[0];
	const contentDoc: AxcutDocument = {
		...sampleDoc,
		assets: [
			{
				...sampleDoc.assets[0],
				// Dimensions filled in so the hook's backfill probe has nothing to do.
				cameraTrack: {
					sourcePath: "/tmp/camera.webm",
					startMs: 0,
					offsetMs: 0,
					visible: true,
					width: 1280,
					height: 720,
				},
			},
			{
				id: "audio_1",
				kind: "audio",
				label: "vo.mp3",
				originalPath: "/tmp/vo.mp3",
				durationSec: 30,
				cameraTrack: null,
			},
		],
		transcripts: [{ assetId: "asset_1", language: "en", segments: [], words: [] }],
		timeline: {
			...sampleDoc.timeline,
			clips: [
				clipA,
				{
					...clipA,
					id: "clip_b",
					sourceStartSec: 10,
					sourceEndSec: 20,
					timelineStartSec: 10,
					timelineEndSec: 20,
				},
			],
			muteRanges: [{ startSec: 3, endSec: 4, reason: "pause" }],
			captionRanges: [{ startSec: 1, endSec: 2, reason: "caption" }],
		},
		audioTracks: [
			{
				id: "trk_1",
				assetId: "audio_1",
				kind: "voiceover",
				startMs: 0,
				endMs: 5000,
				durationSec: 30,
				offsetMs: 0,
				gainDb: 0,
				loop: false,
				fadeInMs: 0,
				fadeOutMs: 0,
				muted: false,
				label: "vo.mp3",
				origin: "user",
			},
		],
		legacyEditor: { aspectRatio: "16:9" },
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: contentDoc,
			currentTimeSec: 1,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	const addEveryKind = async (result: { current: Timeline }) => {
		for (const kind of editKinds) {
			await act(async () => {
				await addOf[kind](result.current);
			});
		}
	};

	it.each(editKinds)("clears a timeline holding only a %s region", async (kind) => {
		const { result } = renderTimeline();
		await act(async () => {
			await addOf[kind](result.current);
		});
		expect(regionCounts(useProjectStore.getState().document)).toEqual({
			...noRegions,
			[kind]: 1,
		});
		// What the button's visibility reads: the stored regions, the same ones it clears.
		expect(result.current.hasEditRegions).toBe(true);

		await act(async () => {
			await result.current.clearTimeline();
		});
		expect(regionCounts(useProjectStore.getState().document)).toEqual(noRegions);
		expect(result.current.hasEditRegions).toBe(false);
	});

	// A trim whose carrying clip is gone is stored but not drawn: `coalescedTrimGroups` drops
	// it from the lane, and loading accepts it (no schema rule ties `clipId` to a clip). The
	// button follows the STORED regions, or it would hide while the action still had one to clear.
	it("counts and clears a stored trim whose clip no longer exists, though no pill shows it", async () => {
		const orphanDoc: AxcutDocument = {
			...contentDoc,
			timeline: {
				...contentDoc.timeline,
				trimRanges: [
					{
						id: "trim_orphan",
						assetId: "asset_1",
						clipId: "clip_gone",
						startSec: 1,
						endSec: 3,
						reason: "",
						origin: "user",
					},
				],
			},
		};
		// Loading keeps it: the schema does not tie a trim's `clipId` to an existing clip.
		expect(parseDocumentFile(orphanDoc).timeline.trimRanges).toHaveLength(1);
		useProjectStore.setState({ document: orphanDoc });
		const { result } = renderTimeline();
		expect(result.current.hasEditRegions).toBe(true);

		await act(async () => {
			await result.current.clearTimeline();
		});
		expect(useProjectStore.getState().document?.timeline.trimRanges).toEqual([]);
		expect(result.current.hasEditRegions).toBe(false);
	});

	it("clears every region kind at once and keeps clips, media, audio, captions and transcript", async () => {
		const { result } = renderTimeline();
		await addEveryKind(result);
		const before = useProjectStore.getState().document;
		expect(regionCounts(before)).toEqual({
			zoom: 1,
			trim: 1,
			annotation: 1,
			speed: 1,
			cameraFullscreen: 1,
			cameraMotion: 1,
			screenMotion: 1,
		});

		await act(async () => {
			await result.current.clearTimeline();
		});
		const after = useProjectStore.getState().document;
		expect(regionCounts(after)).toEqual(noRegions);
		expect(after?.timeline.clips).toEqual(before?.timeline.clips);
		expect(after?.timeline.clips).toHaveLength(2);
		expect(after?.assets).toEqual(before?.assets);
		expect(after?.audioTracks).toEqual(before?.audioTracks);
		expect(after?.audioTracks).toHaveLength(1);
		expect(after?.transcripts).toEqual(before?.transcripts);
		expect(after?.timeline.captionRanges).toEqual(before?.timeline.captionRanges);
		expect(after?.timeline.muteRanges).toEqual(before?.timeline.muteRanges);
		expect((after?.legacyEditor as { aspectRatio?: string }).aspectRatio).toBe("16:9");
	});

	it("is one undo step: a single Ctrl+Z restores every region, redo clears them again", async () => {
		const { result } = renderTimeline();
		await addEveryKind(result);
		const before = useProjectStore.getState().document;
		const stepsBefore = past.length;

		await act(async () => {
			await result.current.clearTimeline();
		});
		expect(past).toHaveLength(stepsBefore + 1);

		act(() => {
			expect(undo()).toBe(true);
		});
		expect(useProjectStore.getState().document).toEqual(before);
		expect(regionCounts(useProjectStore.getState().document)).toEqual({
			zoom: 1,
			trim: 1,
			annotation: 1,
			speed: 1,
			cameraFullscreen: 1,
			cameraMotion: 1,
			screenMotion: 1,
		});

		act(() => {
			expect(redo()).toBe(true);
		});
		expect(regionCounts(useProjectStore.getState().document)).toEqual(noRegions);
	});

	it("lets go of a selection that pointed at a region it just removed", async () => {
		const { result } = renderTimeline();
		// A fresh annotation is auto-selected.
		await act(async () => {
			await result.current.addAnnotation();
		});
		expect(result.current.selection?.kind).toBe("annotation");

		await act(async () => {
			await result.current.clearTimeline();
		});
		expect(result.current.selection).toBeNull();
		expect(result.current.multiSelection).toEqual([]);
	});

	it("writes nothing when the timeline holds no edit region, whatever else it holds", async () => {
		const { result } = renderTimeline();
		// Audio track, captions and clips are all there, and none of them is an edit.
		expect(result.current.hasEditRegions).toBe(false);
		await act(async () => {
			await result.current.clearTimeline();
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(past).toHaveLength(0);
	});
});

describe("useTimeline zoom modifiers (rotation + focus mode)", () => {
	const docWithZoom: AxcutDocument = {
		...sampleDoc,
		zoomRanges: [
			{
				id: "zoom_a",
				startMs: 1000,
				endMs: 3000,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "manual",
				// v5 clip anchor: clip_a draws source 0..10 at timeline 0..10, so the
				// 1000..3000ms ruler span is source 1..3 of that clip. `startMs`/`endMs`
				// stay as the derived cache. (The fixture used to carry a
				// `clipStartOffsetMs` that exists in no schema and no reader.)
				clipId: "clip_a",
				sourceStartSec: 1,
				sourceEndSec: 3,
			},
		],
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: docWithZoom,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("sets a 3D rotation preset on the region", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", "left");
		});
		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({
			id: "zoom_a",
			rotationPreset: "left",
		});
	});

	it("clears the preset back to a flat frame", async () => {
		// "None" in the UI is the ABSENCE of a preset, not a fourth one: the schema field is
		// optional and the native side treats anything unrecognised as zero rotation.
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", "left");
		});
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", undefined);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0].rotationPreset).toBeUndefined();
	});

	it("switches focus mode without disturbing the rotation preset", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", "left");
		});
		await act(async () => {
			await result.current.updateZoomFocusMode("zoom_a", "auto");
		});
		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({
			rotationPreset: "left",
			focusMode: "auto",
		});
	});

	it("stores a moving camera in the same field as the fixed angles", async () => {
		// One control, one field: a moving camera replaces a fixed angle instead of stacking on it.
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", "left");
		});
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", "orbit");
		});
		const zoom = useProjectStore.getState().document?.zoomRanges[0];
		expect(zoom?.rotationPreset).toBe("orbit");
		expect(zoom).not.toHaveProperty("cameraMotion");
	});

	it("updates hideCursor on a zoom region", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateZoomHideCursor("zoom_a", true);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0].hideCursor).toBe(true);

		await act(async () => {
			await result.current.updateZoomHideCursor("zoom_a", false);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0].hideCursor).toBeUndefined();
	});

	it("rolls a live focus edit back when its commit cannot be saved", async () => {
		bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "project file locked" });
		const { result } = renderTimeline();

		act(() => result.current.updateZoomFocusLive("zoom_a", { cx: 0.8, cy: 0.2 }));
		expect(useProjectStore.getState().document?.zoomRanges[0]?.focus).toEqual({
			cx: 0.8,
			cy: 0.2,
		});

		await act(async () => {
			await result.current.commitZoomFocus();
		});

		expect(useProjectStore.getState().document?.zoomRanges[0]?.focus).toEqual({
			cx: 0.5,
			cy: 0.5,
		});
		// Still dirty, deliberately. The rollback target is the document this drag
		// started from, not the last SAVED one, so claiming "clean" would let the window
		// close on unsaved work without a prompt.
		expect(useProjectStore.getState().dirty).toBe(true);
		// The live edit advanced revision once; restoring a different document
		// advances it again so async work cannot mistake the rollback for the
		// optimistic document it replaced.
		expect(useProjectStore.getState().revision).toBe(3);
		expect(toastErrorMock).toHaveBeenCalledWith("Failed to save project", {
			description: "project file locked",
		});
	});

	it("does not restore another project's document after the project changed", async () => {
		// A drag does not always end in a commit: `ZoomFocusOverlay` unmounts the instant
		// `focusMode` flips to "auto", so `endDrag` never runs and the snapshot outlives
		// the project. Restoring it into the NEXT project put project A's document in
		// project B, and the following successful save wrote A over B on disk.
		const { result, rerender } = renderTimeline();

		act(() => result.current.updateZoomFocusLive("zoom_a", { cx: 0.8, cy: 0.2 }));

		const otherProjectDoc: AxcutDocument = {
			...docWithZoom,
			project: { ...docWithZoom.project, id: "proj_other", title: "Other" },
		};
		act(() => {
			useProjectStore.setState({ projectId: "proj_other", document: otherProjectDoc });
		});
		rerender();

		bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "project file locked" });
		await act(async () => {
			await result.current.commitZoomFocus();
		});

		expect(useProjectStore.getState().document?.project.id).toBe("proj_other");
	});
});

// Regression guard for the playhead-stutter fix. `currentTimeSec` is rewritten on
// every animation frame during playback, and `useTimeline()` is called by the editor
// shell — so subscribing to the playhead here re-rendered the entire editor (timeline,
// clips, waveforms, inspector) 60×/s, which is exactly what made the playhead itself
// stutter. The hook must read the playhead imperatively: zero re-renders per tick, but
// still the LIVE value at the moment an action fires.
describe("useTimeline is not re-rendered by playhead ticks", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
			currentTimeSec: 0,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("does not re-render across a second of 60 Hz playhead writes", () => {
		let renders = 0;
		renderHook(
			() => {
				renders++;
				return useTimeline();
			},
			{ wrapper: I18nProvider },
		);
		const baseline = renders;

		// One act() per write: a single batched act() would collapse all 60 into one
		// React pass and hide the very thing this asserts.
		for (let i = 1; i <= 60; i++) {
			act(() => {
				useProjectStore.getState().setCurrentTime(i / 60);
			});
		}

		expect(renders - baseline).toBe(0);
		expect(useProjectStore.getState().currentTimeSec).toBeCloseTo(1);
	});

	it("still anchors a new region at the live playhead", async () => {
		const { result } = renderTimeline();
		act(() => {
			useProjectStore.getState().setCurrentTime(4.2);
		});
		await act(async () => {
			await result.current.addZoom();
		});
		expect(useProjectStore.getState().document?.zoomRanges.at(-1)).toMatchObject({
			startMs: 4200,
			endMs: 6200,
			// Framing what the pointer does, not the middle of the screen.
			focusMode: "auto",
		});
	});

	// Pasting a copied trim is exactly this call: a trim carries no properties, so
	// all a copy holds is its length, and paste recreates one that long at the
	// playhead. Same primitive the toolbar's cut button uses.
	it("creates a trim of the requested length", async () => {
		const { result } = renderTimeline();
		act(() => {
			useProjectStore.getState().setCurrentTime(3);
		});
		await act(async () => {
			await result.current.addTrim(1.25);
		});
		const trim = useProjectStore.getState().document?.timeline.trimRanges.at(-1);
		expect((trim?.endSec ?? 0) - (trim?.startSec ?? 0)).toBeCloseTo(1.25, 6);
	});

	// The timeline's toolbar passes a duration worth a fixed number of pixels at
	// the current zoom; every other entry point keeps the 2 s above.
	it("honours a caller-supplied duration", async () => {
		const { result } = renderTimeline();
		act(() => {
			useProjectStore.getState().setCurrentTime(4.2);
		});
		await act(async () => {
			await result.current.addZoom(0.4);
		});
		expect(useProjectStore.getState().document?.zoomRanges.at(-1)).toMatchObject({
			startMs: 4200,
			endMs: 4600,
		});
	});
});

describe("useTimeline selection", () => {
	// A pill and a clip are one selection, not two. While both could be set at
	// once, copy/paste keyed off "is a clip selected?" and so acted on the clip
	// whatever the user had actually clicked.
	it("lets a clip and a pill cancel each other", () => {
		const { result } = renderTimeline();

		act(() => result.current.selectClip("clip_1"));
		expect(result.current.clipSelection).toBe("clip_1");

		act(() => result.current.selectRegion("zoom", "z1"));
		expect(result.current.selection).toMatchObject({ kind: "zoom", id: "z1" });
		expect(result.current.clipSelection).toBeNull();

		act(() => result.current.selectClip("clip_2"));
		expect(result.current.clipSelection).toBe("clip_2");
		expect(result.current.selection).toBeNull();
		expect(result.current.multiSelection).toEqual([]);

		act(() => result.current.clearSelection());
		expect(result.current.selection).toBeNull();
		expect(result.current.clipSelection).toBeNull();
	});
});

describe("useTimeline save failures", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		toastErrorMock.mockReset();
		bridgeMocks.save.mockResolvedValue({ success: false, error: "disk full" });
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	it("surfaces a rejected mutation without applying it or leaking the rejection", async () => {
		const { result } = renderTimeline();

		await act(async () => {
			await expect(result.current.removeClip("clip_a")).resolves.toBeUndefined();
		});

		expect(toastErrorMock).toHaveBeenCalledWith("Failed to save project", {
			description: "disk full",
		});
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(1);
		expect(useProjectStore.getState().document?.timeline.clips[0]?.id).toBe("clip_a");
	});

	it("leaves the timeline and the history untouched when a split cannot be saved", async () => {
		// The split computes both halves up front, so a refused write is the moment where a
		// half-applied edit would show: the clips must stay as they were, no undo step may be
		// pushed for an edit that never landed, and the failure must be reported rather than
		// swallowed.
		useProjectStore.setState({ currentTimeSec: 5 });
		const stepsBefore = past.length;
		const { result } = renderTimeline();

		await act(async () => {
			await result.current.splitClipAtPlayhead();
		});

		expect(toastErrorMock).toHaveBeenCalledWith("Failed to save project", {
			description: "disk full",
		});
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(1);
		expect(useProjectStore.getState().document?.timeline.clips[0]?.hardCutAfter).toBeUndefined();
		expect(past).toHaveLength(stepsBefore);
	});

	it("commits the same split as one undo step once the write goes through", async () => {
		// The mirror image: same call, same playhead, the write succeeds. If the failure path
		// left anything behind, this run would not be a clean single step.
		useProjectStore.setState({ currentTimeSec: 5 });
		// The bridge echoes the document back on success; a bare `{ success: true }` would leave
		// the store with nothing to adopt and this test would pass for the wrong reason.
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		const stepsBefore = past.length;
		const { result } = renderTimeline();

		await act(async () => {
			await result.current.splitClipAtPlayhead();
		});

		const clips = useProjectStore.getState().document?.timeline.clips ?? [];
		expect(clips).toHaveLength(2);
		expect(clips[0].hardCutAfter).toBe(true);
		expect(clips[0].timelineEndSec).toBe(5);
		expect(clips[1].timelineStartSec).toBe(5);
		expect(past).toHaveLength(stepsBefore + 1);
		expect(toastErrorMock).not.toHaveBeenCalled();
	});

	it("reports 0 zooms added when the bulk write fails", async () => {
		// The count is what the Auto-enhance caller shows in its success toast, so a
		// failed write returning `suggestions.length` produced "Added 3 automatic zooms"
		// stacked on "Failed to save project", with no zoom anywhere. The caller guards
		// on this 0 (`V4Timeline` runAutoZooms).
		const { result } = renderTimeline();

		let added: number | undefined;
		await act(async () => {
			added = await result.current.addZoomsBulk([
				{ span: { start: 1000, end: 2000 }, focus: { cx: 0.5, cy: 0.5 }, depth: 3 },
			]);
		});

		expect(added).toBe(0);
		expect(useProjectStore.getState().document?.zoomRanges).toHaveLength(0);
	});
});

describe("useTimeline undo history", () => {
	// `addAsset` (electron/ai-edition/document-service.ts) never writes `durationSec`,
	// so EVERY freshly imported asset lands at the 60s placeholder and fires the
	// background probe. Anything the probe records is therefore on the undo stack of
	// every single drop, which is what makes these two the common case and not an
	// edge one.
	const unprobed = {
		id: "asset_3",
		kind: "video" as const,
		label: "fresh-import.mp4",
		originalPath: "/tmp/fresh-import.mp4",
		durationSec: undefined,
		// No `video` either: that is what `addAsset` produces, and it is what makes
		// `probeAndCorrectClip` save even once the clip it came for is gone.
		cameraTrack: null,
	};

	const docWithZoom: AxcutDocument = {
		...sampleDoc,
		zoomRanges: [
			{
				id: "zoom_a",
				startMs: 1000,
				endMs: 3000,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "manual",
				clipId: "clip_a",
				sourceStartSec: 1,
				sourceEndSec: 3,
			},
		],
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		probeVideoDurationMock.mockReset();
		probeVideoDimensionsMock.mockResolvedValue({ width: 1920, height: 1080 });
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	function seed(document: AxcutDocument) {
		useProjectStore.setState({
			projectId: "proj_test",
			document,
			revision: 1,
			status: "ready",
			error: null,
		});
	}

	it("keeps the background duration probe off the undo stack", async () => {
		// Without `{ history: false }` on `probeAndCorrectClip`'s save, dropping a clip
		// left `past` = [beforeDrop, dropWithPlaceholderClip]: the first Ctrl+Z snapped
		// the clip back to a 60s placeholder instead of removing it.
		seed({ ...sampleDoc, assets: [...sampleDoc.assets, unprobed] });
		probeVideoDurationMock.mockResolvedValue(5);
		const { result } = renderTimeline();

		await act(async () => {
			await result.current.insertClipAt("asset_3", 1);
		});
		await waitFor(() => {
			const inserted = useProjectStore
				.getState()
				.document?.timeline.clips.find((c) => c.assetId === "asset_3");
			expect(inserted?.sourceEndSec).toBe(5);
		});

		// One step for the drop the user made, none for the probe that corrected it.
		expect(past).toHaveLength(1);
		act(() => {
			expect(undo()).toBe(true);
		});
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(1);
	});

	it("does not let a probe landing after an undo destroy the redo", async () => {
		// The probe is detached from the drop, so it can resolve at any point — including
		// after the user has already pressed Ctrl+Z. A recording save there ran
		// `pushHistory`, which clears `future` on its way past: redo was gone, wiped by a
		// write the user never made and never saw.
		seed({ ...sampleDoc, assets: [...sampleDoc.assets, unprobed] });
		let landProbe!: (durationSec: number) => void;
		probeVideoDurationMock.mockReturnValue(
			new Promise<number>((resolvePromise) => {
				landProbe = resolvePromise;
			}),
		);
		const { result } = renderTimeline();

		await act(async () => {
			await result.current.insertClipAt("asset_3", 1);
		});
		expect(past).toHaveLength(1);

		act(() => {
			expect(undo()).toBe(true);
		});
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(1);
		expect(future).toHaveLength(1);

		await act(async () => {
			landProbe(5);
			// The clip is gone, so only the dimensions half of the probe still has
			// anything to write — and that is exactly the write that used to be recorded.
			await new Promise((resolveTick) => setTimeout(resolveTick, 0));
		});

		expect(past).toHaveLength(0);
		expect(future).toHaveLength(1);
		act(() => {
			expect(redo()).toBe(true);
		});
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(2);
	});

	// Holds the first document save until the test releases it; every later one lands at once.
	const gateFirstSave = () => {
		const gate: { release?: () => void } = {};
		let calls = 0;
		bridgeMocks.save.mockImplementation(async (doc: AxcutDocument) => {
			calls += 1;
			if (calls === 1) {
				await new Promise<void>((resolve) => {
					gate.release = resolve;
				});
			}
			return { success: true, document: doc };
		});
		return gate;
	};

	it("lands rapid zoom-level steps in order, one undo step each", async () => {
		seed(docWithZoom);
		const gate = gateFirstSave();
		const { result } = renderTimeline();

		const p4 = result.current.updateZoomDepth("zoom_a", 4);
		const p5 = result.current.updateZoomDepth("zoom_a", 5);
		await waitFor(() => expect(gate.release).toEqual(expect.any(Function)));
		await act(async () => {
			gate.release?.();
			await Promise.all([p4, p5]);
		});

		expect(useProjectStore.getState().document?.zoomRanges[0]?.depth).toBe(5);
		act(() => {
			expect(undo()).toBe(true);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0]?.depth).toBe(4);
	});

	// A custom scale overrides the depth, so a preset that left it in place would change a
	// field the render never reads.
	it("clamps a custom zoom level to the renderer's range, and a preset clears it", async () => {
		seed(docWithZoom);
		const { result } = renderTimeline();

		await act(async () => {
			await result.current.updateZoomCustomScale("zoom_a", 9);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0]?.customScale).toBe(5);

		await act(async () => {
			await result.current.updateZoomDepth("zoom_a", 4);
		});
		const zoom = useProjectStore.getState().document?.zoomRanges[0];
		expect(zoom?.depth).toBe(4);
		expect(zoom?.customScale).toBeUndefined();
	});

	it("keeps a pending zoom level when the 3D tilt is changed before it lands", async () => {
		seed(docWithZoom);
		const gate = gateFirstSave();
		const { result } = renderTimeline();

		const pDepth = result.current.updateZoomDepth("zoom_a", 4);
		const pRotation = result.current.updateZoomRotation("zoom_a", "left");
		await waitFor(() => expect(gate.release).toEqual(expect.any(Function)));
		await act(async () => {
			gate.release?.();
			await Promise.all([pDepth, pRotation]);
		});

		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({
			depth: 4,
			rotationPreset: "left",
		});
	});

	// A resize built its save from the render's document, outside the zoom chain: whichever of
	// the two saves landed last put the other's field back.
	it("keeps a pending zoom level when the pill is resized before it lands", async () => {
		seed(docWithZoom);
		const gate = gateFirstSave();
		const { result } = renderTimeline();

		const pDepth = result.current.updateZoomDepth("zoom_a", 4);
		const pSpan = result.current.updateZoomSpan("zoom_a", 1500, 3500);
		await waitFor(() => expect(gate.release).toEqual(expect.any(Function)));
		await act(async () => {
			gate.release?.();
			await Promise.all([pDepth, pSpan]);
		});

		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({
			depth: 4,
			startMs: 1500,
			endMs: 3500,
		});
	});

	// The inspector's "Reset focus point" is a live write and its commit in one click, next to
	// the level buttons. The level landing first also takes the live focus off screen, so the
	// commit has to put it back on top rather than save what it finds.
	it("keeps a pending zoom level when a focus is committed before it lands", async () => {
		seed(docWithZoom);
		const gate = gateFirstSave();
		const { result } = renderTimeline();

		const pDepth = result.current.updateZoomDepth("zoom_a", 4);
		await waitFor(() => expect(gate.release).toEqual(expect.any(Function)));
		act(() => result.current.updateZoomFocusLive("zoom_a", { cx: 0.8, cy: 0.2 }));
		const pCommit = result.current.commitZoomFocus();
		await act(async () => {
			gate.release?.();
			await Promise.all([pDepth, pCommit]);
		});

		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({
			depth: 4,
			focus: { cx: 0.8, cy: 0.2 },
		});
		// One undo step each, the focus first.
		act(() => {
			expect(undo()).toBe(true);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({
			depth: 4,
			focus: { cx: 0.5, cy: 0.5 },
		});
		act(() => {
			expect(undo()).toBe(true);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0]?.depth).toBe(3);
	});

	// The commit's focus is put back only over a write of its own epoch. A drag abandoned
	// (`ZoomFocusOverlay` unmounts when the focus mode flips to auto) and then undone must stay
	// undone when a bare commit (`endDrag` with nothing in front of it) comes later.
	it("does not put an abandoned drag's focus back after an undo", async () => {
		seed(docWithZoom);
		const { result } = renderTimeline();

		await act(async () => {
			await result.current.updateZoomDepth("zoom_a", 4);
		});
		act(() => result.current.updateZoomFocusLive("zoom_a", { cx: 0.8, cy: 0.2 }));
		act(() => {
			expect(undo()).toBe(true);
		});
		expect(future).toHaveLength(1);

		await act(async () => {
			await result.current.commitZoomFocus();
		});

		expect(useProjectStore.getState().document?.zoomRanges[0]?.focus).toEqual({
			cx: 0.5,
			cy: 0.5,
		});
		expect(future).toHaveLength(1);
	});

	// A zoom write that runs while a focus drag is on screen saves the dragged focus too, so the
	// commit finds nothing left to record. That write's undo step has to reach back to before
	// the drag, or no Ctrl+Z could ever bring the old focus back.
	it("undoes a focus drag with the zoom write that saved it", async () => {
		seed(docWithZoom);
		const { result } = renderTimeline();

		act(() => result.current.updateZoomFocusLive("zoom_a", { cx: 0.8, cy: 0.2 }));
		await act(async () => {
			await result.current.updateZoomDepth("zoom_a", 4);
		});
		await act(async () => {
			await result.current.commitZoomFocus();
		});

		act(() => {
			expect(undo()).toBe(true);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({
			depth: 3,
			focus: { cx: 0.5, cy: 0.5 },
		});
	});

	// Rebase-review finding (queued zoom writes vs. document replacement): a zoom write
	// queued behind a still-pending one starts AFTER an undo has restored the document,
	// and must not apply its stale patch to the replacement. The in-flight write itself
	// is dropped by `saveDocument`'s epoch check; the queued one is the hole.
	it("drops a queued zoom write that starts after an undo replaces the document", async () => {
		seed(docWithZoom);
		const { result } = renderTimeline();
		// One settled write so the undo has a recorded state to restore.
		await act(async () => {
			await result.current.updateZoomDepth("zoom_a", 4);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0]?.depth).toBe(4);

		const gate = gateFirstSave();
		const pRotation = result.current.updateZoomRotation("zoom_a", "left");
		const pCursor = result.current.updateZoomHideCursor("zoom_a", true);
		await waitFor(() => expect(gate.release).toEqual(expect.any(Function)));
		let undid = false;
		act(() => {
			undid = undo();
		});
		expect(undid).toBe(true);
		expect(useProjectStore.getState().document?.zoomRanges[0]?.depth).toBe(3);

		await act(async () => {
			gate.release?.();
			await Promise.allSettled([pRotation, pCursor]);
		});

		// The undo's result stands; neither queued write landed on the restored document.
		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({ depth: 3 });
		expect(useProjectStore.getState().document?.zoomRanges[0]?.rotationPreset).toBeUndefined();
		expect(useProjectStore.getState().document?.zoomRanges[0]?.hideCursor).toBeUndefined();
	});

	// Same finding through the project-switch path: `loadProject` replaces projectId and
	// document without superseding the queue, and project B deliberately contains the same
	// region id, so a stale patch must not escape detection by id coincidence.
	it("drops queued zoom writes when a project switch replaces the document", async () => {
		seed(docWithZoom);
		const { result } = renderTimeline();
		const projectB: AxcutDocument = {
			...docWithZoom,
			project: { ...docWithZoom.project, id: "proj_b", title: "Project B" },
			zoomRanges: [{ ...docWithZoom.zoomRanges[0]!, depth: 2 }],
		};

		const gate = gateFirstSave();
		const pRotation = result.current.updateZoomRotation("zoom_a", "left");
		const pCursor = result.current.updateZoomHideCursor("zoom_a", true);
		await waitFor(() => expect(gate.release).toEqual(expect.any(Function)));
		bridgeMocks.get.mockResolvedValue({ success: true, document: projectB });
		await act(async () => {
			await useProjectStore.getState().loadProject("proj_b");
		});
		expect(useProjectStore.getState().projectId).toBe("proj_b");

		await act(async () => {
			gate.release?.();
			await Promise.allSettled([pRotation, pCursor]);
		});

		// Project B's own zoom_a is untouched by the stale project-A queue.
		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({
			id: "zoom_a",
			depth: 2,
		});
		expect(useProjectStore.getState().document?.zoomRanges[0]?.rotationPreset).toBeUndefined();
		expect(useProjectStore.getState().document?.zoomRanges[0]?.hideCursor).toBeUndefined();
	});

	// Rebase-review finding (stalled save blocks the zoom queue): while one zoom save's
	// answer is unknown (bridge never settles), later zoom-pane writes must not queue
	// behind it forever — they are refused until the unknown save settles, then work
	// again. The refusal is the safe half: the unknown save may still land, so racing
	// it would recreate the stale-document overwrite this chain exists to prevent.
	it("refuses zoom writes while a save is unknown and recovers when it settles", async () => {
		seed(docWithZoom);
		vi.useFakeTimers();
		try {
			let hungDoc: AxcutDocument | undefined;
			let releaseHungSave: (result: { success: boolean; document: AxcutDocument }) => void;
			bridgeMocks.save.mockImplementation((doc: AxcutDocument) => {
				hungDoc = doc;
				return new Promise((resolve) => {
					releaseHungSave = (result) => {
						// Settle this one call only; later saves answer immediately.
						bridgeMocks.save.mockImplementation(async (next: AxcutDocument) => ({
							success: true,
							document: next,
						}));
						resolve(result);
					};
				});
			});
			const { result } = renderTimeline();

			let depthOk: boolean | undefined;
			act(() => {
				void result.current.updateZoomDepth("zoom_a", 4).then((ok) => {
					depthOk = ok;
				});
			});
			// Deadline passes with the bridge still silent: the write's result is unknown,
			// reported to the caller as not-taken, and the document is left alone.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(10_000);
			});
			expect(depthOk).toBe(false);
			expect(useProjectStore.getState().document?.zoomRanges[0]?.depth).toBe(3);

			// A later zoom write is refused while that save is still unknown.
			let rotationOk: boolean | undefined;
			await act(async () => {
				rotationOk = await result.current.updateZoomRotation("zoom_a", "left");
			});
			expect(rotationOk).toBe(false);
			expect(useProjectStore.getState().document?.zoomRanges[0]?.rotationPreset).toBeUndefined();

			// The unknown save settles late — it may land — and the refusal clears.
			await act(async () => {
				releaseHungSave({ success: true, document: hungDoc! });
				for (let i = 0; i < 20; i++) await Promise.resolve();
			});
			await act(async () => {
				await result.current.updateZoomDepth("zoom_a", 5);
			});
			expect(useProjectStore.getState().document?.zoomRanges[0]?.depth).toBe(5);
		} finally {
			vi.useRealTimers();
		}
	});

	// A focus commit out of time leaves the zoom chain, but its save can still fail. The drag
	// must come off screen then, as for any failed commit, or a later save persists it.
	it("rolls a focus drag back when its commit fails after the deadline", async () => {
		seed(docWithZoom);
		vi.useFakeTimers();
		try {
			let failHungSave: () => void;
			bridgeMocks.save.mockImplementation(
				() =>
					new Promise((resolve) => {
						failHungSave = () => resolve({ success: false, error: "disk full" });
					}),
			);
			const { result } = renderTimeline();

			act(() => result.current.updateZoomFocusLive("zoom_a", { cx: 0.8, cy: 0.2 }));
			act(() => {
				void result.current.commitZoomFocus();
			});
			// No answer by the deadline: the save may still land, so the drag stays.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(10_000);
			});
			expect(useProjectStore.getState().document?.zoomRanges[0]?.focus).toEqual({
				cx: 0.8,
				cy: 0.2,
			});

			await act(async () => {
				failHungSave();
				for (let i = 0; i < 20; i++) await Promise.resolve();
			});
			expect(useProjectStore.getState().document?.zoomRanges[0]?.focus).toEqual({
				cx: 0.5,
				cy: 0.5,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	// Rebase-review follow-up (unknown save × replacement): the refusal must not outlive
	// its reason. Once an undo bumps the epoch, the stuck save can no longer install
	// anything (`saveDocument` drops it), so it must stop blocking zoom writes — even if
	// the bridge never answers. A project switch does NOT bump the epoch, so there the
	// stuck save can still land and the refusal correctly stays.
	it("stops refusing zoom writes once a replacement makes the unknown save unable to land", async () => {
		seed(docWithZoom);
		vi.useFakeTimers();
		try {
			let hungDoc: AxcutDocument | undefined;
			let releaseHungSave: (result: { success: boolean; document: AxcutDocument }) => void = () => {
				// replaced once the hung save registers
			};
			let saveCalls = 0;
			bridgeMocks.save.mockImplementation((doc: AxcutDocument) => {
				saveCalls += 1;
				if (saveCalls === 2) {
					// The write whose answer never comes; the test never releases it until
					// the very end, and then only to prove the epoch guard drops it.
					hungDoc = doc;
					return new Promise((resolve) => {
						releaseHungSave = resolve;
					});
				}
				return Promise.resolve({ success: true, document: doc });
			});
			const { result } = renderTimeline();

			// One settled write so the undo has a recorded state to restore.
			await act(async () => {
				await result.current.updateZoomDepth("zoom_a", 4);
			});
			expect(useProjectStore.getState().document?.zoomRanges[0]?.depth).toBe(4);

			let depthOk: boolean | undefined;
			act(() => {
				void result.current.updateZoomDepth("zoom_a", 5).then((ok) => {
					depthOk = ok;
				});
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(10_000);
			});
			expect(depthOk).toBe(false);

			// The undo replaces the document; the stuck save can no longer install it.
			let undid = false;
			act(() => {
				undid = undo();
			});
			expect(undid).toBe(true);

			// Zoom writes must work again on the restored document.
			await act(async () => {
				const ok = await result.current.updateZoomDepth("zoom_a", 5);
				expect(ok).toBe(true);
			});
			expect(useProjectStore.getState().document?.zoomRanges[0]?.depth).toBe(5);

			// When the stuck save finally settles, the epoch guard drops it — the restored
			// (and since re-edited) document stands.
			await act(async () => {
				releaseHungSave({ success: true, document: hungDoc! });
				for (let i = 0; i < 20; i++) await Promise.resolve();
			});
			expect(useProjectStore.getState().document?.zoomRanges[0]?.depth).toBe(5);
		} finally {
			vi.useRealTimers();
		}
	});

	it("resolves a zoom-level write with whether the save took effect", async () => {
		seed(docWithZoom);
		const { result } = renderTimeline();
		bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "read-only" });

		let ok: boolean | undefined;
		await act(async () => {
			ok = await result.current.updateZoomDepth("zoom_a", 4);
		});

		expect(ok).toBe(false);
		expect(useProjectStore.getState().document?.zoomRanges[0]?.depth).toBe(3);
	});

	it("leaves no undo step behind a focus drag whose commit failed", async () => {
		// The drag used to push its pre-drag document from the FIRST `setDocument`. When
		// the commit then failed, `commitZoomFocus` restored that same document through
		// `setState` — which cannot pop the entry. `past` was left holding a snapshot
		// identical to what was on screen (a Ctrl+Z that visibly does nothing) and
		// `future` had already been wiped by the push.
		seed(docWithZoom);
		const { result } = renderTimeline();

		// An edit and an undo, so there is a redo entry to lose.
		await act(async () => {
			await result.current.updateZoomDepth("zoom_a", 5);
		});
		act(() => {
			expect(undo()).toBe(true);
		});
		expect(past).toHaveLength(0);
		expect(future).toHaveLength(1);

		const beforeDrag = useProjectStore.getState().document;
		bridgeMocks.save.mockResolvedValue({ success: false, error: "disk full" });
		act(() => {
			result.current.updateZoomFocusLive("zoom_a", { cx: 0.2, cy: 0.3 });
			result.current.updateZoomFocusLive("zoom_a", { cx: 0.25, cy: 0.35 });
		});
		await act(async () => {
			await result.current.commitZoomFocus();
		});

		expect(useProjectStore.getState().document).toBe(beforeDrag);
		expect(past).toHaveLength(0);
		expect(future).toHaveLength(1);
		act(() => {
			expect(redo()).toBe(true);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0].depth).toBe(5);
	});

	it("records one undo step for a whole focus drag once it commits", async () => {
		// The other half of the same change: moving the record to the commit must not
		// lose it. Sixty pointermoves, one Ctrl+Z, back to where the drag started.
		seed(docWithZoom);
		const { result } = renderTimeline();

		act(() => {
			for (let i = 0; i < 60; i++) {
				result.current.updateZoomFocusLive("zoom_a", { cx: 0.2 + i / 1000, cy: 0.3 });
			}
		});
		expect(past).toHaveLength(0);

		await act(async () => {
			await result.current.commitZoomFocus();
		});

		expect(past).toHaveLength(1);
		act(() => {
			expect(undo()).toBe(true);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0].focus).toEqual({
			cx: 0.5,
			cy: 0.5,
		});
	});
});

// What a drag's snapshot is allowed to still be holding once the drag is over.
//
// `zoomFocusRollbackRef` / `annotationRollbackRef` hold the document a drag started
// from, kept until the commit that records it. A drag does not always reach a commit,
// and both commits are reachable without one: the inspector's annotation `<textarea>`
// writes live on every keystroke and commits `onBlur`, so closing the panel unmounts the
// focused node before blur can fire (the region's own delete button is an `onClick`, which
// runs after blur, so that route does not reach here) -- and `SliderCell` wires
// mouseup/touchend/keyup straight to `onCommit` with no `onChange` in front, so a bare
// click on a stroke-width thumb reaches `commitAnnotationChange()` carrying that
// leftover. `NewEditorShell` builds ONE `useTimeline()` and hands it to the inspector,
// so the abandonable live write and the bare commit share an instance.
describe("useTimeline drag snapshots", () => {
	const docWithRegions: AxcutDocument = {
		...sampleDoc,
		zoomRanges: [
			{
				id: "zoom_a",
				startMs: 1000,
				endMs: 3000,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "manual",
				clipId: "clip_a",
				sourceStartSec: 1,
				sourceEndSec: 3,
			},
		],
		annotations: [
			{
				id: "ann_a",
				startMs: 1000,
				endMs: 3000,
				clipId: "clip_a",
				sourceStartSec: 1,
				sourceEndSec: 3,
				type: "text",
				content: "before",
				textContent: "",
				position: { x: 50, y: 50 },
				size: { width: 30, height: 20 },
				style: {
					color: "#ffffff",
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
			},
		],
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		probeVideoDimensionsMock.mockResolvedValue({ width: 1920, height: 1080 });
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: docWithRegions,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		clearHistory();
		vi.clearAllMocks();
	});

	/** Two recording edits between the abandoned live write and the bare commit, so the
	 *  stale snapshot is one the stack has already buried. */
	async function twoZoomDepthEdits(result: { current: ReturnType<typeof useTimeline> }) {
		await act(async () => {
			await result.current.updateZoomDepth("zoom_a", 4);
		});
		await act(async () => {
			await result.current.updateZoomDepth("zoom_a", 5);
		});
	}

	it("does not hand a bare annotation commit a base the edits since have buried", async () => {
		const { result } = renderTimeline();

		// The keystrokes that never reach their `onBlur`.
		act(() => result.current.updateAnnotationLive("ann_a", { content: "typed" }));
		await twoZoomDepthEdits(result);
		expect(past).toHaveLength(2);

		// The bare click on a slider thumb.
		await act(async () => {
			await result.current.commitAnnotationChange();
		});

		// Same project, so nothing is cleared -- the cost is that one Ctrl+Z jumps over
		// BOTH zoom edits and lands on the document the abandoned typing started from.
		expect(past).toHaveLength(2);
		act(() => {
			expect(undo()).toBe(true);
		});
		const doc = useProjectStore.getState().document;
		expect(doc?.zoomRanges[0].depth).toBe(4);
		expect(doc?.annotations[0].content).toBe("typed");
	});

	it("does not restore a buried document when a bare annotation commit fails", async () => {
		// The worse half: `rollback` is used as a DOCUMENT here, not only as a
		// `historyBase`, so a failed bare commit wrote the stale snapshot back into the
		// store and both zoom edits were silently gone.
		const { result } = renderTimeline();

		act(() => result.current.updateAnnotationLive("ann_a", { content: "typed" }));
		await twoZoomDepthEdits(result);

		const onScreen = useProjectStore.getState().document;
		bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "disk full" });
		await act(async () => {
			await result.current.commitAnnotationChange();
		});

		expect(useProjectStore.getState().document).toBe(onScreen);
		expect(onScreen?.zoomRanges[0].depth).toBe(5);
		expect(onScreen?.annotations[0].content).toBe("typed");
	});

	it("does not hand a bare focus commit a base the edits since have buried", async () => {
		// `ZoomFocusOverlay.handlePointerDown` sets `draggingRef` BEFORE its live write,
		// and that write returns early on a zero-size overlay rect -- so `endDrag` fires
		// `commitZoomFocus()` with nothing in front of it.
		const { result } = renderTimeline();

		act(() => result.current.updateZoomFocusLive("zoom_a", { cx: 0.8, cy: 0.2 }));
		await twoZoomDepthEdits(result);
		expect(past).toHaveLength(2);

		await act(async () => {
			await result.current.commitZoomFocus();
		});

		expect(past).toHaveLength(2);
		act(() => {
			expect(undo()).toBe(true);
		});
		const doc = useProjectStore.getState().document;
		expect(doc?.zoomRanges[0].depth).toBe(4);
		expect(doc?.zoomRanges[0].focus).toEqual({ cx: 0.8, cy: 0.2 });
	});

	it("does not restore a buried document when a bare focus commit fails", async () => {
		const { result } = renderTimeline();

		act(() => result.current.updateZoomFocusLive("zoom_a", { cx: 0.8, cy: 0.2 }));
		await twoZoomDepthEdits(result);

		const onScreen = useProjectStore.getState().document;
		bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "disk full" });
		await act(async () => {
			await result.current.commitZoomFocus();
		});

		expect(useProjectStore.getState().document).toBe(onScreen);
		expect(onScreen?.zoomRanges[0].depth).toBe(5);
	});

	it("still records the pre-drag document when an annotation drag reaches its commit", async () => {
		// The guard must not cost the feature it guards: a drag that ends the way a drag
		// normally ends is still ONE undo step, back to before it.
		const { result } = renderTimeline();

		act(() => result.current.updateAnnotationLive("ann_a", { content: "ty" }));
		act(() => result.current.updateAnnotationLive("ann_a", { content: "typed" }));
		await act(async () => {
			await result.current.commitAnnotationChange();
		});

		expect(past).toHaveLength(1);
		act(() => {
			expect(undo()).toBe(true);
		});
		expect(useProjectStore.getState().document?.annotations[0].content).toBe("before");
	});
});

// Issue #350 — imported audio tracks. The hook wraps the pure ops in
// document/audioTracks.ts (unit-tested separately); these cover the wiring:
// asset lookup, playhead placement, the save, and undo.
describe("useTimeline audio tracks", () => {
	const audioDoc: AxcutDocument = {
		...sampleDoc,
		assets: [
			...sampleDoc.assets,
			{
				id: "audio_1",
				kind: "audio",
				label: "voiceover.mp3",
				originalPath: "/tmp/vo.mp3",
				durationSec: 30,
				cameraTrack: null,
			},
		],
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		probeAudioDurationMock.mockReset();
		probeAudioDurationMock.mockResolvedValue(null);
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: audioDoc,
			revision: 1,
			status: "ready",
			error: null,
			currentTimeSec: 4,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("addAudioTrack places a track for the asset at the playhead and returns its id", async () => {
		const { result } = renderTimeline();
		let id: string | null = null;
		await act(async () => {
			id = await result.current.addAudioTrack("audio_1");
		});
		const tracks = useProjectStore.getState().document?.audioTracks ?? [];
		expect(tracks).toHaveLength(1);
		expect(id).toBe(tracks[0]?.id);
		expect(tracks[0]).toMatchObject({
			assetId: "audio_1",
			durationSec: 30,
			// Head at the playhead (4s), span the source's own length.
			startMs: 4000,
			label: "voiceover.mp3",
		});
	});

	it("addAudioTrack refuses a non-audio (or unknown) asset", async () => {
		const { result } = renderTimeline();
		let videoId: string | null = "x";
		let missingId: string | null = "x";
		await act(async () => {
			videoId = await result.current.addAudioTrack("asset_1"); // a video asset
			missingId = await result.current.addAudioTrack("nope");
		});
		expect(videoId).toBeNull();
		expect(missingId).toBeNull();
		expect(useProjectStore.getState().document?.audioTracks).toEqual([]);
	});

	it("place / gain update the track and each is one undo step", async () => {
		const { result } = renderTimeline();
		let id = "";
		await act(async () => {
			id = (await result.current.addAudioTrack("audio_1", 2)) ?? "";
		});
		// A lane drag commits the whole span in one write and re-ventilates it.
		await act(async () => {
			await result.current.placeAudioTrack(id, { startMs: 3000, endMs: 8000 });
		});
		await act(async () => {
			await result.current.setAudioTrackGain(id, -6);
		});

		const track = useProjectStore.getState().document?.audioTracks[0];
		expect(track).toMatchObject({
			startMs: 3000,
			endMs: 8000,
			gainDb: -6,
		});

		// Three writes (add + place + gain) → the gain edit undoes first.
		act(() => {
			expect(undo()).toBe(true);
		});
		// Back to the level a new music bed is placed at.
		expect(useProjectStore.getState().document?.audioTracks[0]?.gainDb).toBe(-18);
	});

	it("clamps a track to the content under it, like every other anchored region", async () => {
		// The sample timeline is one 0..10s clip. A track dragged past the end has
		// nothing to anchor to out there — and the exported programme stops at the
		// last clip regardless — so the span is cut at the content, not stored
		// hanging off the end where it could never play.
		const { result } = renderTimeline();
		let id = "";
		await act(async () => {
			id = (await result.current.addAudioTrack("audio_1", 2)) ?? "";
		});
		await act(async () => {
			await result.current.placeAudioTrack(id, { startMs: 9000, endMs: 16_000 });
		});
		const track = useProjectStore.getState().document?.audioTracks[0];
		expect(track).toMatchObject({ startMs: 9000, endMs: 10_000 });
	});

	it("turning loop on fills the rest of the programme, in one undo step", async () => {
		// Looping only means anything when the span exceeds the source, so a toggle
		// that changed nothing else did nothing at all. The sample timeline is one
		// 0..10s clip and the asset is 30s, so the track is created 2..10 (clamped
		// to the content) and filling is a no-op — place it short first.
		const { result } = renderTimeline();
		let id = "";
		await act(async () => {
			id = (await result.current.addAudioTrack("audio_1", 2)) ?? "";
		});
		await act(async () => {
			await result.current.placeAudioTrack(id, { startMs: 2000, endMs: 4000 });
		});
		await act(async () => {
			await result.current.setAudioTrackLoop(id, true);
		});
		const tracks = useProjectStore.getState().document?.audioTracks ?? [];
		expect(tracks[0]).toMatchObject({ startMs: 2000, endMs: 10_000, loop: true });

		// One step: the flag and the fill undo together.
		act(() => {
			expect(undo()).toBe(true);
		});
		const back = useProjectStore.getState().document?.audioTracks[0];
		expect(back).toMatchObject({ endMs: 4000, loop: false });
	});

	it("turning loop off leaves the span alone", async () => {
		// Shrinking back would throw away a length the user may have set by hand.
		const { result } = renderTimeline();
		let id = "";
		await act(async () => {
			id = (await result.current.addAudioTrack("audio_1", 2)) ?? "";
		});
		await act(async () => {
			await result.current.setAudioTrackLoop(id, true);
		});
		const filled = useProjectStore.getState().document?.audioTracks[0]?.endMs;
		await act(async () => {
			await result.current.setAudioTrackLoop(id, false);
		});
		const track = useProjectStore.getState().document?.audioTracks[0];
		expect(track?.loop).toBe(false);
		expect(track?.endMs).toBe(filled);
	});

	it("removeAudioTrack deletes the track", async () => {
		const { result } = renderTimeline();
		let id = "";
		await act(async () => {
			id = (await result.current.addAudioTrack("audio_1")) ?? "";
		});
		await act(async () => {
			await result.current.removeAudioTrack(id);
		});
		expect(useProjectStore.getState().document?.audioTracks).toEqual([]);
	});

	// #350: the toolbar button and the `M` shortcut both call `tl.addAudio`, which opens
	// the OS file picker and hands the result to `importAudioAsset`. Spy on the store's
	// import so these assert the wiring (picker → import), not the import itself.
	it("addAudio imports the picked file, and is a no-op when the picker is cancelled", async () => {
		const importSpy = vi.fn().mockResolvedValue(null);
		useProjectStore.setState({ importAudioAsset: importSpy });
		const pickerMock = vi.fn();
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: { openAudioFilePicker: pickerMock },
		});
		const { result } = renderTimeline();

		// Cancelled picker → nothing imported.
		pickerMock.mockResolvedValueOnce({ success: false });
		await act(async () => {
			await result.current.addAudio();
		});
		expect(importSpy).not.toHaveBeenCalled();

		// Picked a file → imported with its path and display name.
		pickerMock.mockResolvedValueOnce({ success: true, path: "/tmp/bgm.mp3", name: "bgm.mp3" });
		await act(async () => {
			await result.current.addAudio();
		});
		expect(importSpy).toHaveBeenCalledWith("/tmp/bgm.mp3", "bgm.mp3");
	});

	it("addAudio clears region/clip selections after a successful import", async () => {
		// importAudioAsset must resolve an asset for the success path to run.
		useProjectStore.setState({ importAudioAsset: vi.fn().mockResolvedValue({ id: "audio_1" }) });
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: {
				openAudioFilePicker: vi
					.fn()
					.mockResolvedValue({ success: true, path: "/tmp/bgm.mp3", name: "bgm.mp3" }),
			},
		});
		const { result } = renderTimeline();

		// A clip selected before the import (selectClip and selectRegion are mutually
		// exclusive, so a clip is enough to prove the import wipes the local selection)…
		act(() => result.current.selectClip("clip_1"));
		expect(result.current.clipSelection).toBe("clip_1");

		await act(async () => {
			await result.current.addAudio();
		});
		// …is gone after it (the imported track becomes the sole selection).
		expect(result.current.selection).toBeNull();
		expect(result.current.multiSelection).toEqual([]);
		expect(result.current.clipSelection).toBeNull();
	});

	it("addAudio toasts when the file picker itself rejects", async () => {
		toastErrorMock.mockClear();
		const importSpy = vi.fn();
		useProjectStore.setState({ importAudioAsset: importSpy });
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: { openAudioFilePicker: vi.fn().mockRejectedValueOnce(new Error("ipc down")) },
		});
		const { result } = renderTimeline();

		await act(async () => {
			await result.current.addAudio();
		});
		// A picker rejection reaches the localized toast, not an unhandled rejection, and never
		// attempts an import.
		expect(importSpy).not.toHaveBeenCalled();
		expect(toastErrorMock).toHaveBeenCalledTimes(1);
	});

	// #350 regression: a failed import-time probe leaves durationSec at 0, which
	// makes the playback window zero-length. The on-load backfill re-probes and
	// stamps the real duration onto the asset AND the track, so it can play again.
	it("backfills a missing audio duration on load", async () => {
		probeAudioDurationMock.mockResolvedValue(12.5);
		// Asset imported with an unknown duration (probe failed), and a track that
		// cached the resulting 0.
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				assets: [
					...sampleDoc.assets,
					{
						id: "audio_2",
						kind: "audio",
						label: "bgm.mp3",
						originalPath: "/tmp/bgm.mp3",
						cameraTrack: null,
					},
				],
				audioTracks: [
					{
						id: "trk_2",
						assetId: "audio_2",
						kind: "music" as const,
						startMs: 0,
						endMs: 1,
						durationSec: 0,
						offsetMs: 0,
						gainDb: 0,
						loop: false,
						fadeInMs: 0,
						fadeOutMs: 0,
						muted: false,
						label: "bgm.mp3",
						origin: "user" as const,
					},
				],
			},
			revision: 1,
			status: "ready",
			error: null,
		});
		renderTimeline();
		await waitFor(() => {
			const doc = useProjectStore.getState().document;
			expect(doc?.assets.find((a) => a.id === "audio_2")?.durationSec).toBe(12.5);
			expect(doc?.audioTracks[0]?.durationSec).toBe(12.5);
		});
		expect(probeAudioDurationMock).toHaveBeenCalledTimes(1);
	});
});

// The wand (`V4Timeline.runAutoZooms`) captures this callback, awaits a
// multi-second cursor-telemetry IPC, and only then calls it. Anything the user
// commits during that wait is in the store but not in the callback's render
// closure, so reading the closure writes back a snapshot that drops their edit.
// Its `add*` siblings compute and save in the same tick, which is why this one
// is the reachable case.
describe("useTimeline.addZoomsBulk reads the document at write time", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		toastErrorMock.mockReset();
		bridgeMocks.save.mockImplementation(async (document: AxcutDocument) => ({
			success: true,
			document,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	it("does not write back the document from before the telemetry wait", async () => {
		const { result } = renderTimeline();
		// Captured the way the wand captures it: before the wait, not after.
		const addZoomsBulk = result.current.addZoomsBulk;

		// The user's edit lands while the wand is off fetching telemetry.
		const edited: AxcutDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Edited while the wand was busy" },
		};
		act(() => {
			useProjectStore.setState({ document: edited, revision: 2 });
		});

		let added: number | undefined;
		await act(async () => {
			added = await addZoomsBulk([
				{ span: { start: 1000, end: 2000 }, focus: { cx: 0.5, cy: 0.5 }, depth: 3 },
			]);
		});

		expect(added).toBe(1);
		const saved = bridgeMocks.save.mock.calls.at(-1)?.[0] as AxcutDocument;
		// The zoom was added, and the edit is still there.
		expect(saved.zoomRanges).toHaveLength(1);
		expect(saved.project.title).toBe("Edited while the wand was busy");
		expect(useProjectStore.getState().document?.project.title).toBe(
			"Edited while the wand was busy",
		);
	});

	// Reading the document fresh is what makes this reachable: the spans were built
	// from the OLD project's telemetry and its ruler, so writing them into whatever is
	// loaded now puts one project's zooms in another. `saveDocument`'s epoch check does
	// not cover it -- the write is issued after the switch, not across it.
	it("writes nothing when the project changed during the telemetry wait", async () => {
		const { result } = renderTimeline();
		const addZoomsBulk = result.current.addZoomsBulk;

		// The user switches projects while the wand is off fetching telemetry.
		act(() => {
			useProjectStore.setState({
				projectId: "proj_switched_to",
				document: sampleDoc,
				revision: 2,
			});
		});

		let added: number | undefined;
		await act(async () => {
			added = await addZoomsBulk([
				{ span: { start: 1000, end: 2000 }, focus: { cx: 0.5, cy: 0.5 }, depth: 3 },
			]);
		});

		expect(added).toBe(0);
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});
});

describe("useTimeline.splitClipAtPlayhead — cutting a clip that already ends in a cut", () => {
	// A[0-6] | user cut | B[6-12], both from one recording and meeting exactly at 6 — the shape the
	// split itself produces, so splitting again has to survive it.
	const cutDoc = (): AxcutDocument => ({
		...sampleDoc,
		timeline: {
			...sampleDoc.timeline,
			clips: [
				{
					id: "clip_a",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 6,
					timelineStartSec: 0,
					timelineEndSec: 6,
					wordRefs: [],
					origin: "user" as const,
					reason: "",
					hardCutAfter: true,
				},
				{
					id: "clip_b",
					assetId: "asset_1",
					sourceStartSec: 6,
					sourceEndSec: 12,
					timelineStartSec: 6,
					timelineEndSec: 12,
					wordRefs: [],
					origin: "user" as const,
					reason: "",
				},
			],
		},
	});
	const seed = (doc: AxcutDocument, atSec: number) =>
		useProjectStore.setState({
			projectId: "proj_test",
			document: doc,
			currentTimeSec: atSec,
			revision: 1,
			status: "ready",
			error: null,
		});
	const spans = () =>
		(useProjectStore.getState().document?.timeline.clips ?? []).map(
			(c) => `${c.timelineStartSec}-${c.timelineEndSec}${c.hardCutAfter ? "|cut" : ""}`,
		);

	it("keeps the ORIGINAL cut on the tail and adds the new one on the head", async () => {
		seed(cutDoc(), 3);
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.splitClipAtPlayhead();
		});
		expect(spans()).toEqual(["0-3|cut", "3-6|cut", "6-12"]);
	});

	it("survives a save and reopen with both cuts intact", async () => {
		seed(cutDoc(), 3);
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.splitClipAtPlayhead();
		});
		const saved = useProjectStore.getState().document;
		// Round-trip through the same parser a reopen uses: a flag the schema drops would vanish here.
		const reopened = parseDocumentFile(JSON.parse(JSON.stringify(saved)));
		expect(reopened.timeline.clips.map((c) => c.hardCutAfter)).toEqual([true, true, undefined]);
	});

	it("is a no-op on an existing boundary, and pushes no history", async () => {
		seed(cutDoc(), 6);
		const stepsBefore = past.length;
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.splitClipAtPlayhead();
		});
		expect(spans()).toEqual(["0-6|cut", "6-12"]);
		expect(past).toHaveLength(stepsBefore);
	});

	it("is one undo step, and redo puts both cuts back", async () => {
		seed(cutDoc(), 3);
		const stepsBefore = past.length;
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.splitClipAtPlayhead();
		});
		expect(past).toHaveLength(stepsBefore + 1);
		expect(undo()).toBe(true);
		expect(spans()).toEqual(["0-6|cut", "6-12"]);
		expect(redo()).toBe(true);
		expect(spans()).toEqual(["0-3|cut", "3-6|cut", "6-12"]);
	});
});

describe("batch editing a multi-selection of moves", () => {
	// The camera asset the move gate asks for (`hasAnyClipWithCamera`); the same one the
	// camera describe above builds, kept local so these tests do not share its fixture.
	const cameraAsset = {
		id: "asset_1",
		kind: "video" as const,
		label: "screen.webm",
		originalPath: "/tmp/screen.webm",
		durationSec: 30,
		video: { codec: "unknown", width: 1920, height: 1080, fps: 0 },
		cameraTrack: {
			type: "video" as const,
			sourcePath: "/tmp/camera.webm",
			startMs: 0,
			offsetMs: 0,
			visible: true,
			width: 1280,
			height: 720,
		},
	};

	const motion = () => useProjectStore.getState().document?.cameraMotionRegions ?? [];
	const screenMotion = () => useProjectStore.getState().document?.screenMotionRegions ?? [];

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: { ...sampleDoc, assets: [cameraAsset] },
			currentTimeSec: 1,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	/** Two disjoint moves: 1–3s (fullscreen) and 5–7s (default), both on clip_a. */
	const seedTwoMoves = async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addCameraMotion();
		});
		useProjectStore.setState({ currentTimeSec: 5 });
		await act(async () => {
			await result.current.addCameraMotion(2, CAMERA_MOTION_DEFAULT_TARGET);
		});
		const ids = motion().map((r) => r.id);
		expect(ids).toHaveLength(2);
		return { result, ids };
	};

	it("moves every selected move by the same delta, keeping their spacing", async () => {
		const { result, ids } = await seedTwoMoves();
		const savesBefore = bridgeMocks.save.mock.calls.length;
		const stepsBefore = past.length;

		await act(async () => {
			await result.current.moveMotionRegions(
				[
					{ kind: "cameraMotion", id: ids[0] },
					{ kind: "cameraMotion", id: ids[1] },
				],
				500,
			);
		});

		expect(motion().map((r) => [r.startMs, r.endMs])).toEqual([
			[1500, 3500],
			[5500, 7500],
		]);
		// The gap is the thing a block move is FOR: it must not change.
		expect(motion()[1].startMs - motion()[0].endMs).toBe(2000);
		// One write, one undo step, for the whole block.
		expect(bridgeMocks.save).toHaveBeenCalledTimes(savesBefore + 1);
		expect(past).toHaveLength(stepsBefore + 1);
	});

	it("carries each region's own target and timing, and leaves the clip anchor alone", async () => {
		const { result, ids } = await seedTwoMoves();
		const before = motion().map((r) => ({
			id: r.id,
			target: r.target,
			timing: r.timing,
			clipId: r.clipId,
		}));

		await act(async () => {
			await result.current.moveMotionRegions(
				[
					{ kind: "cameraMotion", id: ids[0] },
					{ kind: "cameraMotion", id: ids[1] },
				],
				-500,
			);
		});

		const after = motion().map((r) => ({
			id: r.id,
			target: r.target,
			timing: r.timing,
			clipId: r.clipId,
		}));
		// Same ids, same payload, same anchor — only the span moved.
		expect(after).toEqual(before);
		expect(motion().map((r) => r.startMs)).toEqual([500, 4500]);
	});

	it("undoes the whole block in one step", async () => {
		const { result, ids } = await seedTwoMoves();
		const before = motion().map((r) => [r.startMs, r.endMs]);

		await act(async () => {
			await result.current.moveMotionRegions(
				[
					{ kind: "cameraMotion", id: ids[0] },
					{ kind: "cameraMotion", id: ids[1] },
				],
				800,
			);
		});
		expect(motion().map((r) => [r.startMs, r.endMs])).not.toEqual(before);

		act(() => {
			undo();
		});
		expect(motion().map((r) => [r.startMs, r.endMs])).toEqual(before);
	});

	it("writes nothing for a zero delta or a selection with no moves in it", async () => {
		const { result, ids } = await seedTwoMoves();
		const savesBefore = bridgeMocks.save.mock.calls.length;
		const stepsBefore = past.length;

		await act(async () => {
			await result.current.moveMotionRegions([{ kind: "cameraMotion", id: ids[0] }], 0);
		});
		await act(async () => {
			await result.current.moveMotionRegions([{ kind: "zoom", id: "z1" }], 500);
		});

		expect(bridgeMocks.save).toHaveBeenCalledTimes(savesBefore);
		expect(past).toHaveLength(stepsBefore);
	});

	it("applies pasted properties to every selected move in one write", async () => {
		const { result, ids } = await seedTwoMoves();
		// Give the second move a target of its own, so the pasted values differ from BOTH
		// recipients' current ones. Without that, one of them would already match the source
		// and the test would pass even if only the focused move were patched — which is the
		// exact defect it exists to catch.
		await act(async () => {
			await result.current.setCameraMotionTarget(ids[1], {
				size: 0.5,
				position: { x: 0.3, y: 0.3 },
			});
		});
		const source = motion().find((r) => r.id === ids[1]);
		expect(source?.target.size).toBe(0.5);
		expect(motion().find((r) => r.id === ids[0])?.target.size).toBe(1);

		act(() => {
			result.current.selectRegion("cameraMotion", ids[0]);
			result.current.selectRegion("cameraMotion", ids[1], { additive: true });
		});
		expect(result.current.multiSelection).toHaveLength(2);

		const savesBefore = bridgeMocks.save.mock.calls.length;
		const stepsBefore = past.length;
		let outcome: string | undefined;
		await act(async () => {
			outcome = await result.current.pasteMotionAttributes({
				kind: "cameraMotion",
				region: { ...source },
			});
		});

		expect(outcome).toBe("saved");
		// Both now carry the source's target — the recipient that was NOT focused included.
		expect(motion().every((r) => r.target.size === 0.5)).toBe(true);
		expect(motion().every((r) => r.target.position.x === 0.3)).toBe(true);
		expect(bridgeMocks.save).toHaveBeenCalledTimes(savesBefore + 1);
		expect(past).toHaveLength(stepsBefore + 1);
	});

	it("still refuses a paste whose kind is not in the selection", async () => {
		const { result, ids } = await seedTwoMoves();
		const source = motion()[0];

		act(() => {
			result.current.selectRegion("screenMotion", "sm_1");
		});
		let outcome: string | undefined;
		await act(async () => {
			outcome = await result.current.pasteMotionAttributes({
				kind: "cameraMotion",
				region: { ...source },
			});
		});

		expect(outcome).toBe("invalidTarget");
		expect(motion().map((r) => r.id)).toEqual(ids);
		expect(screenMotion()).toHaveLength(0);
	});
});

// The spotlight of an APPLIED zoom.
//
// The Smart Zoom pane could only light a suggestion that had not been applied yet, so once a
// zoom was on the timeline its dimming/size/feather were frozen at whatever the suggestion
// carried. These four bind the pane's new door to the same rules the rest of the store
// follows: one undo step per gesture, off keeps the zoom, reset returns the shared numbers.
describe("useTimeline zoom spotlight", () => {
	const zoomDoc = (effect?: {
		size: number;
		softness: number;
		dimming: number;
	}): AxcutDocument => ({
		...sampleDoc,
		zoomRanges: [
			{
				id: "zoom_1",
				startMs: 1000,
				endMs: 4000,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "manual",
				...(effect ? { focusEffect: { shape: "radial" as const, ...effect } } : {}),
			},
		],
	});

	const zoom = () => useProjectStore.getState().document?.zoomRanges[0];

	beforeEach(() => {
		clearHistory();
		useProjectStore.getState().clear();
		bridgeMocks.save.mockReset();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: zoomDoc(),
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	it("switches a spotlight on with the shared default numbers, as one undo step", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.setZoomSpotlight("zoom_1", true);
		});
		expect(zoom()?.focusEffect).toEqual({ ...ZOOM_SPOTLIGHT_DEFAULT });
		expect(past).toHaveLength(1);

		await act(async () => {
			expect(undo()).toBe(true);
		});
		expect(zoom()?.focusEffect).toBeUndefined();
	});

	it("switches it off without touching the zoom itself", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.setZoomSpotlight("zoom_1", true);
		});
		await act(async () => {
			await result.current.setZoomSpotlight("zoom_1", false);
		});
		const region = zoom();
		expect(region?.focusEffect ?? null).toBeNull();
		expect(region).toMatchObject({ id: "zoom_1", startMs: 1000, endMs: 4000, depth: 3 });
		expect(region?.focus).toEqual({ cx: 0.5, cy: 0.5 });
	});

	it("records a whole slider drag as ONE undo step", async () => {
		useProjectStore.setState({ document: zoomDoc({ size: 0.3, softness: 0.25, dimming: 0.35 }) });
		const { result } = renderTimeline();
		const stepsBefore = past.length;

		await act(async () => {
			for (const value of [40, 50, 60]) {
				result.current.setZoomFocusEffectLive("zoom_1", { dimming: value / 100 });
			}
		});
		expect(zoom()?.focusEffect?.dimming).toBeCloseTo(0.6, 6);
		expect(past).toHaveLength(stepsBefore);

		await act(async () => {
			await result.current.commitZoomFocusEffect();
		});
		expect(past).toHaveLength(stepsBefore + 1);

		await act(async () => {
			expect(undo()).toBe(true);
		});
		expect(zoom()?.focusEffect?.dimming).toBeCloseTo(0.35, 6);
	});

	it("resets to the defaults a suggestion would have produced", async () => {
		useProjectStore.setState({ document: zoomDoc({ size: 0.15, softness: 0.6, dimming: 0.7 }) });
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.resetZoomSpotlight("zoom_1");
		});
		expect(zoom()?.focusEffect).toEqual({ ...ZOOM_SPOTLIGHT_DEFAULT });
	});
});

// The Smart Zoom batch.
//
// The panel's "Apply" is two calls, not one: it puts the next document on screen without
// history, then saves it with the document it started from as `historyBase`. That is what
// makes a batch of three suggestions a SINGLE Ctrl+Z — and it is why the panel's own wiring
// cannot be covered by a test of `appendAutoZoomSuggestions` alone. This walks exactly those
// two calls with three real suggestions, and checks that the zooms already on the timeline
// come back untouched from the undo.
describe("useTimeline batch apply of auto-zooms", () => {
	const manual = (id: string, startMs: number, endMs: number) => ({
		id,
		startMs,
		endMs,
		depth: 2 as const,
		focus: { cx: 0.3, cy: 0.3 },
		focusMode: "manual" as const,
	});

	const withManualZooms = (): AxcutDocument => ({
		...sampleDoc,
		zoomRanges: [manual("zoom_manual_1", 300, 1000), manual("zoom_manual_2", 1100, 1800)],
	});

	const suggestions = [
		{ span: { start: 3000, end: 5000 }, focus: { cx: 0.25, cy: 0.3 }, depth: 2 as const },
		{ span: { start: 7000, end: 9000 }, focus: { cx: 0.7, cy: 0.4 }, depth: 2 as const },
		{ span: { start: 11000, end: 13000 }, focus: { cx: 0.4, cy: 0.75 }, depth: 2 as const },
	];

	const zooms = () => useProjectStore.getState().document?.zoomRanges ?? [];

	beforeEach(() => {
		clearHistory();
		useProjectStore.getState().clear();
		bridgeMocks.save.mockReset();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: withManualZooms(),
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	it("adds three regions as ONE undo step and puts the two hand-made zooms back untouched", async () => {
		renderTimeline();
		const store = useProjectStore.getState();
		const before = store.document;
		expect(before).not.toBeNull();
		if (!before) return;
		const stepsBefore = past.length;

		// Exactly what `applyAutoZooms` does, in the same order.
		const next = appendAutoZoomSuggestions(before, suggestions);
		await act(async () => {
			store.setDocument(next, { history: false });
			await store.saveDocument(next, { history: true, historyBase: before });
		});

		expect(zooms()).toHaveLength(5);
		expect(past).toHaveLength(stepsBefore + 1);
		const manualAfter = zooms().filter((z) => z.id.startsWith("zoom_manual"));
		expect(manualAfter).toEqual(before.zoomRanges);

		await act(async () => {
			expect(undo()).toBe(true);
		});
		expect(zooms()).toHaveLength(2);
		expect(zooms()).toEqual(before.zoomRanges);

		await act(async () => {
			expect(redo()).toBe(true);
		});
		expect(zooms()).toHaveLength(5);
		expect(zooms().filter((z) => z.id.startsWith("zoom_manual"))).toEqual(before.zoomRanges);
	});
});
