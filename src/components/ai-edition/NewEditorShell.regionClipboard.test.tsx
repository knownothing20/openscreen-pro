// @vitest-environment jsdom
// Camera motion through the region clipboard.
//
// `cameraMotion` is a first-class region kind, so it has to travel the same road as the
// others: copy the SELECTED pill into `regionClipboard`, paste at the playhead, land through
// the same anchoring every `add*` uses. These tests drive the REAL shell — real useTimeline,
// real shortcuts, real store — because what is under test is the wiring between them; a
// stubbed timeline would only prove the stub works.
//
// Paste reads the clipboard and nothing else, so most cases need no selection at all and go
// through Ctrl+V alone. The two copy cases press a pill, which is what selects it on the
// timeline (`startPillDrag` selects before it measures anything).
//
// What must NOT happen is just as important as what must: a camera move must not degrade into
// the legacy `cameraFullscreen` span on the way through the clipboard, and the legacy span
// must not be dragged up into the new model. The two formats stay separate.

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("@/contexts/ShortcutsContext", async () => {
	const { DEFAULT_SHORTCUTS } = await import("@/lib/shortcuts");
	return {
		useShortcuts: () => ({
			shortcuts: DEFAULT_SHORTCUTS,
			isMac: false,
			isConfigOpen: false,
			openConfig: () => {
				/* not exercised here */
			},
			closeConfig: () => {
				/* not exercised here */
			},
			setShortcuts: () => {
				/* not exercised here */
			},
			persistShortcuts: () => Promise.resolve(true),
		}),
	};
});

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({
		locale: "en",
		setLocale: () => {
			/* fixed locale */
		},
	}),
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

const bridgeMocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			get: bridgeMocks.get,
			save: bridgeMocks.save,
		},
	},
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import type { CameraMotionRegion } from "@/lib/ai-edition/cameraMotion/resolve";
import { type AxcutDocument, axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	clearRegionClipboard,
	copyRegion,
	pasteClipboard,
} from "@/lib/ai-edition/store/regionClipboard";
import { clearHistory, redo, undo } from "@/lib/ai-edition/store/undo";
import { NewEditorShell } from "./NewEditorShell";

/** The authored move these tests copy: a square that slides up-left, 45% wide, 0.8 opaque. */
const CAMERA_MOTION_SRC: CameraMotionRegion = {
	id: "cammotion_src",
	startMs: 1000,
	endMs: 4000,
	timing: { leadInSec: 0.6, returnSec: 0.9, easing: "cubic" },
	target: {
		layout: "shape",
		shape: "square",
		position: { x: 0.2, y: 0.25 },
		size: 0.45,
		roundness: 0.5,
		opacity: 0.8,
	},
};

/** A fullscreen move: same field, `layout: "fullscreen"` — it must stay a camera move. */
const CAMERA_MOTION_FULLSCREEN_SRC: CameraMotionRegion = {
	id: "cammotion_full_src",
	startMs: 1000,
	endMs: 4000,
	timing: { leadInSec: 0.6, returnSec: 0.9, easing: "cubic" },
	target: {
		layout: "fullscreen",
		shape: "square",
		position: { x: 0.5, y: 0.5 },
		size: 1,
		roundness: 0,
		opacity: 1,
	},
};

/** The legacy Full Camera span, on `legacyEditor` — the format that must keep working. */
const LEGACY_FULLSCREEN_SRC = {
	id: "camfull_src",
	startMs: 1000,
	endMs: 3000,
	clipId: "clip_a",
	sourceStartSec: 1,
	sourceEndSec: 3,
};

function makeDoc(overrides: Partial<AxcutDocument> = {}): AxcutDocument {
	return {
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
				// A camera track, so `hasAnyClipWithCamera` is satisfied.
				cameraTrack: {
					sourcePath: "/tmp/camera.webm",
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

function loadDoc(doc: AxcutDocument, currentTimeSec = 5) {
	useProjectStore.setState({
		projectId: "proj_test",
		document: doc,
		revision: 1,
		status: "ready",
		error: null,
		currentTimeSec,
	});
	clearHistory();
}

const motionRegions = () => useProjectStore.getState().document?.cameraMotionRegions ?? [];
const legacyRegions = () =>
	(
		(useProjectStore.getState().document?.legacyEditor as {
			cameraFullscreenRegions?: unknown[];
		}) ?? {}
	).cameraFullscreenRegions ?? [];

function renderShell() {
	return render(
		<TooltipProvider>
			<EditorDialogsProvider>
				<NewEditorShell />
			</EditorDialogsProvider>
		</TooltipProvider>,
	);
}

/** Shortcuts are bound on `window`; the body is what `e.target` is when nothing has focus. */
async function press(init: KeyboardEventInit) {
	await act(async () => {
		fireEvent.keyDown(document.body, init);
	});
}

const paste = () => press({ key: "v", ctrlKey: true });
const copy = () => press({ key: "c", ctrlKey: true });

beforeEach(() => {
	toastSuccess.mockClear();
	toastError.mockClear();
	bridgeMocks.get.mockReset();
	bridgeMocks.save.mockReset();
	bridgeMocks.save.mockImplementation(async (doc: AxcutDocument) => ({
		success: true,
		document: doc,
	}));
	clearRegionClipboard();
	useProjectStore.getState().clear();

	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		onAiEditionChatEvent: () => () => {
			/* unsubscribe */
		},
		setTitleBarOverlay: () => {
			/* no native titlebar */
		},
		setHasUnsavedChanges: () => {
			/* no window close guard */
		},
		onRequestCloseConfirm: () => () => {
			/* unsubscribe */
		},
		onRequestSaveBeforeClose: () => () => {
			/* unsubscribe */
		},
		sendCloseConfirmResponse: () => {
			/* nothing is closing this window */
		},
		findRecordingCamera: () => Promise.resolve(null),
		// The preview probes for a supplemental audio track as soon as a source has a path;
		// `null` is not the shape it reads, so answer with the object it expects.
		preparePreviewAudioTrack: () => Promise.resolve({ success: false, path: null }),
	};
	Element.prototype.scrollTo = () => {
		/* no scrolling in jsdom */
	};
	(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = class {
		observe() {
			/* never fires: nothing has a layout in jsdom */
		}
		unobserve() {
			/* see observe */
		}
		disconnect() {
			/* see observe */
		}
	};
});

afterEach(() => {
	cleanup();
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
	clearRegionClipboard();
	useProjectStore.getState().clear();
});

describe("region clipboard: pasting a camera motion", () => {
	it("creates a new camera motion at the playhead, keeping the authored target", async () => {
		loadDoc(makeDoc({ cameraMotionRegions: [CAMERA_MOTION_SRC] }), 5);
		renderShell();

		copyRegion({
			kind: "cameraMotion",
			region: { ...CAMERA_MOTION_SRC, target: { ...CAMERA_MOTION_SRC.target } },
		});
		await paste();

		expect(motionRegions()).toHaveLength(2);
		const pasted = motionRegions()[1] as unknown as typeof CAMERA_MOTION_SRC;

		// New identity, new span from the playhead, same length.
		expect(pasted.id).not.toBe(CAMERA_MOTION_SRC.id);
		expect(pasted.id.startsWith("cammotion_")).toBe(true);
		expect(pasted.startMs).toBe(5000);
		expect(pasted.endMs).toBe(8000);

		// The authored look and timing ride along untouched.
		expect(pasted.target).toEqual(CAMERA_MOTION_SRC.target);
		expect(pasted.timing).toEqual(CAMERA_MOTION_SRC.timing);
	});

	it("leaves the region it was copied from alone", async () => {
		const original = JSON.parse(JSON.stringify(CAMERA_MOTION_SRC));
		loadDoc(makeDoc({ cameraMotionRegions: [original] }), 5);
		renderShell();

		copyRegion({ kind: "cameraMotion", region: JSON.parse(JSON.stringify(original)) });
		await paste();

		const [first] = motionRegions();
		expect(first.id).toBe(CAMERA_MOTION_SRC.id);
		expect((first as unknown as typeof CAMERA_MOTION_SRC).startMs).toBe(1000);
		expect((first as unknown as typeof CAMERA_MOTION_SRC).endMs).toBe(4000);
		expect((first as unknown as typeof CAMERA_MOTION_SRC).target).toEqual(CAMERA_MOTION_SRC.target);
	});

	it("keeps a fullscreen move a camera motion instead of degrading it to the legacy span", async () => {
		loadDoc(makeDoc({ cameraMotionRegions: [CAMERA_MOTION_FULLSCREEN_SRC] }), 5);
		renderShell();

		copyRegion({ kind: "cameraMotion", region: { ...CAMERA_MOTION_FULLSCREEN_SRC } });
		await paste();

		expect(motionRegions()).toHaveLength(2);
		const pasted = motionRegions()[1] as unknown as typeof CAMERA_MOTION_FULLSCREEN_SRC;
		expect(pasted.target.layout).toBe("fullscreen");
		// Nothing leaked into the legacy envelope.
		expect(legacyRegions()).toHaveLength(0);
	});

	it("refuses a malformed snapshot instead of writing half a region", async () => {
		loadDoc(makeDoc(), 5);
		renderShell();

		// No startMs/endMs: the span cannot be computed, so nothing may be written.
		copyRegion({ kind: "cameraMotion", region: { target: { size: 0.5 } } });
		await paste();

		expect(motionRegions()).toHaveLength(0);
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it("does nothing when the clipboard is empty", async () => {
		loadDoc(makeDoc(), 5);
		renderShell();

		await paste();

		expect(motionRegions()).toHaveLength(0);
	});
});

describe("region clipboard: undo and redo", () => {
	it("records a paste as one undoable edit, and redo puts it back", async () => {
		loadDoc(makeDoc(), 5);
		renderShell();

		copyRegion({ kind: "cameraMotion", region: { ...CAMERA_MOTION_SRC } });
		await paste();
		expect(motionRegions()).toHaveLength(1);

		await act(async () => {
			expect(undo()).toBe(true);
		});
		expect(motionRegions()).toHaveLength(0);

		await act(async () => {
			expect(redo()).toBe(true);
		});
		expect(motionRegions()).toHaveLength(1);
		expect((motionRegions()[0] as unknown as { startMs: number }).startMs).toBe(5000);
	});
});

describe("region clipboard: legacy Full Camera is untouched", () => {
	it("still pastes a legacy span into the legacy envelope", async () => {
		loadDoc(makeDoc({ legacyEditor: { cameraFullscreenRegions: [LEGACY_FULLSCREEN_SRC] } }), 5);
		renderShell();

		copyRegion({ kind: "cameraFullscreen", region: { ...LEGACY_FULLSCREEN_SRC } });
		await paste();

		expect(legacyRegions()).toHaveLength(2);
		// And it did NOT become a camera motion.
		expect(motionRegions()).toHaveLength(0);
	});
});

describe("region clipboard: copying what is selected", () => {
	it("copies a selected camera motion with its authored target", async () => {
		loadDoc(makeDoc({ cameraMotionRegions: [CAMERA_MOTION_SRC] }), 0);
		renderShell();

		fireEvent.pointerDown(await screen.findByText("Camera Motion"));
		await copy();

		const snapshot = pasteClipboard();
		expect(snapshot?.kind).toBe("cameraMotion");
		expect((snapshot?.region as { id: string }).id).toBe(CAMERA_MOTION_SRC.id);
		expect((snapshot?.region as { target: unknown }).target).toEqual(CAMERA_MOTION_SRC.target);
	});

	it("copies nothing when no region is selected", async () => {
		loadDoc(makeDoc({ cameraMotionRegions: [CAMERA_MOTION_SRC] }), 0);
		renderShell();

		await copy();

		expect(pasteClipboard()).toBeNull();
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it("re-anchors into the project it lands in, leaving nothing pointing back at the old one", async () => {
		// Copied in project A, where the move sits on `clip_a`.
		loadDoc(makeDoc({ cameraMotionRegions: [CAMERA_MOTION_SRC] }), 0);
		renderShell();
		fireEvent.pointerDown(await screen.findByText("Camera Motion"));
		await copy();
		expect(pasteClipboard()?.kind).toBe("cameraMotion");

		// The clipboard survives a project switch — the existing rule retires it when a CLIP
		// is copied, not when another project is opened — so what matters is that the paste
		// re-anchors into the project it lands in. `anchorRegionsWithDerivedMs` places it
		// against B's clips, and `parseCameraMotionRegion` stores only
		// `{id, startMs, endMs, timing, target}`: a camera move carries no clip and no asset
		// anchor at all (unlike zoom), so there is nothing of A's that could survive into B.
		const base = makeDoc();
		loadDoc(
			makeDoc({
				project: { ...base.project, id: "proj_b" },
				timeline: {
					...base.timeline,
					clips: [{ ...base.timeline.clips[0], id: "clip_b" }],
				},
			}),
			2,
		);
		await paste();

		expect(motionRegions()).toHaveLength(1);
		const pasted = motionRegions()[0] as unknown as {
			id: string;
			startMs: number;
			endMs: number;
		};
		expect(pasted.id).not.toBe(CAMERA_MOTION_SRC.id);
		// Landed at B's playhead, keeping the copied length.
		expect(pasted.startMs).toBe(2000);
		expect(pasted.endMs).toBe(5000);
		// Nothing that could still point back at project A.
		expect("clipId" in pasted).toBe(false);
		expect("assetId" in pasted).toBe(false);
	});
});
