// @vitest-environment jsdom
// Camera motion and screen motion through the region clipboard.
//
// `cameraMotion` and `screenMotion` are first-class region kinds, so they travel the same road
// as the others: copy the SELECTED pill into `regionClipboard`, paste at the playhead, land
// through the same anchoring every `add*` uses. These tests drive the REAL shell — real
// useTimeline, real shortcuts, real store — because what is under test is the wiring between
// them; a stubbed timeline would only prove the stub works.
//
// Paste reads the clipboard and nothing else, so most cases need no selection at all and go
// through Ctrl+V alone. The two copy cases press a pill, which is what selects it on the
// timeline (`startPillDrag` selects before it measures anything).
//
// What must NOT happen is just as important as what must: a camera move must not degrade into
// the legacy `cameraFullscreen` span on the way through the clipboard, the legacy span must not
// be dragged up into the new model, and a screen move must not arrive as a camera one. The
// kinds stay separate.

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultOpeningSequence } from "@/lib/ai-edition/opening/opening";

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
import type { ScreenMotionRegion } from "@/lib/ai-edition/screenMotion/resolve";
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

/** The authored screen move these tests copy: the card slides right, grows, and tilts. */
const SCREEN_MOTION_SRC: ScreenMotionRegion = {
	id: "screenmotion_src",
	startMs: 1000,
	endMs: 4000,
	timing: { leadInSec: 0.6, returnSec: 0.9, easing: "cubic" },
	target: {
		position: { x: 0.62, y: 0.42 },
		scale: 1.55,
		rotationX: 0,
		rotationY: 32,
		rotationZ: -8,
		perspective: 0.65,
	},
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
		opening: defaultOpeningSequence(),
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
const screenRegions = () => useProjectStore.getState().document?.screenMotionRegions ?? [];
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
		// against B's clips, and the motion parser now KEEPS the anchor it computes, so the
		// move lands bound to B's clip rather than to a bare pair of milliseconds.
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
		// The paste carries a clip anchor now — and it is B'S, not A's. That is stronger than
		// the "no anchor at all" this used to assert: `anchorRegionsWithDerivedMs` always
		// re-homed the move onto B's clip, but the motion parser dropped the triple on the way
		// through, so the anchor it computed never reached the document. What matters is
		// unchanged: nothing points back at project A.
		expect((pasted as { clipId?: string }).clipId).toBe("clip_b");
		expect((pasted as { sourceStartSec?: number }).sourceStartSec).toBe(2);
		expect((pasted as { sourceEndSec?: number }).sourceEndSec).toBe(5);
		expect("assetId" in pasted).toBe(false);
	});
});

describe("region clipboard: pasting a screen motion", () => {
	it("creates a new screen motion at the playhead, keeping the authored target and timing", async () => {
		loadDoc(makeDoc({ screenMotionRegions: [SCREEN_MOTION_SRC] }), 5);
		renderShell();

		copyRegion({
			kind: "screenMotion",
			region: {
				...SCREEN_MOTION_SRC,
				target: { ...SCREEN_MOTION_SRC.target, position: { ...SCREEN_MOTION_SRC.target.position } },
			},
		});
		await paste();

		expect(screenRegions()).toHaveLength(2);
		const pasted = screenRegions()[1] as unknown as ScreenMotionRegion;

		// New identity, new span from the playhead, same length.
		expect(pasted.id).not.toBe(SCREEN_MOTION_SRC.id);
		expect(pasted.id.startsWith("screenmotion_")).toBe(true);
		expect(pasted.startMs).toBe(5000);
		expect(pasted.endMs).toBe(8000);

		// The authored look and timing ride along untouched.
		expect(pasted.target).toEqual(SCREEN_MOTION_SRC.target);
		expect(pasted.timing).toEqual(SCREEN_MOTION_SRC.timing);
	});

	it("lands in the screen motion field, not the camera's and not the legacy envelope", async () => {
		loadDoc(makeDoc(), 5);
		renderShell();

		copyRegion({ kind: "screenMotion", region: { ...SCREEN_MOTION_SRC } });
		await paste();

		expect(screenRegions()).toHaveLength(1);
		// The three destinations are distinct, and this paste belongs to exactly one.
		expect(motionRegions()).toHaveLength(0);
		expect(legacyRegions()).toHaveLength(0);
	});

	it("leaves the region it was copied from alone", async () => {
		const original = JSON.parse(JSON.stringify(SCREEN_MOTION_SRC));
		loadDoc(makeDoc({ screenMotionRegions: [original] }), 5);
		renderShell();

		copyRegion({ kind: "screenMotion", region: JSON.parse(JSON.stringify(original)) });
		await paste();

		const [first] = screenRegions() as unknown as ScreenMotionRegion[];
		expect(first.id).toBe(SCREEN_MOTION_SRC.id);
		expect(first.startMs).toBe(1000);
		expect(first.endMs).toBe(4000);
		expect(first.target).toEqual(SCREEN_MOTION_SRC.target);
	});

	it("refuses a malformed snapshot instead of writing half a region", async () => {
		loadDoc(makeDoc(), 5);
		renderShell();

		// No startMs/endMs: the span cannot be computed, so nothing may be written.
		copyRegion({ kind: "screenMotion", region: { target: { scale: 2 } } });
		await paste();

		expect(screenRegions()).toHaveLength(0);
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it("does nothing when the clipboard is empty", async () => {
		loadDoc(makeDoc(), 5);
		renderShell();

		await paste();

		expect(screenRegions()).toHaveLength(0);
	});

	it("records a paste as one undoable edit, and redo puts it back", async () => {
		loadDoc(makeDoc(), 5);
		renderShell();

		copyRegion({ kind: "screenMotion", region: { ...SCREEN_MOTION_SRC } });
		await paste();
		expect(screenRegions()).toHaveLength(1);

		await act(async () => {
			expect(undo()).toBe(true);
		});
		expect(screenRegions()).toHaveLength(0);

		await act(async () => {
			expect(redo()).toBe(true);
		});
		expect(screenRegions()).toHaveLength(1);
		expect((screenRegions()[0] as unknown as { startMs: number }).startMs).toBe(5000);
	});

	it("copies a selected screen motion with its authored target", async () => {
		loadDoc(makeDoc({ screenMotionRegions: [SCREEN_MOTION_SRC] }), 0);
		renderShell();

		fireEvent.pointerDown(await screen.findByText("Screen Motion"));
		await copy();

		const snapshot = pasteClipboard();
		expect(snapshot?.kind).toBe("screenMotion");
		expect((snapshot?.region as { id: string }).id).toBe(SCREEN_MOTION_SRC.id);
		expect((snapshot?.region as { target: unknown }).target).toEqual(SCREEN_MOTION_SRC.target);
	});
});

describe("region clipboard: the two motion kinds stay apart", () => {
	it("does not let a copied screen move be pasted as a camera move", async () => {
		loadDoc(makeDoc({ cameraMotionRegions: [CAMERA_MOTION_SRC] }), 5);
		renderShell();

		copyRegion({ kind: "screenMotion", region: { ...SCREEN_MOTION_SRC } });
		await paste();

		// The camera's region count is exactly what it was: the paste added a screen move.
		expect(motionRegions()).toHaveLength(1);
		expect(screenRegions()).toHaveLength(1);
	});

	it("does not let a copied camera move be pasted as a screen move", async () => {
		loadDoc(makeDoc({ screenMotionRegions: [SCREEN_MOTION_SRC] }), 5);
		renderShell();

		copyRegion({ kind: "cameraMotion", region: { ...CAMERA_MOTION_SRC } });
		await paste();

		expect(screenRegions()).toHaveLength(1);
		expect(motionRegions()).toHaveLength(1);
	});
});

// Ctrl+Shift+V — paste the COPIED move's PROPERTIES onto the selected move. The ordinary
// Ctrl+V above makes a second region; this one rewrites the selected one in place. What
// identifies the target (id, startMs, endMs, the clip anchor behind them) must survive
// verbatim, and only the authored look must travel — otherwise a "paste" would quietly
// re-time or re-anchor the user's move, which is the one thing they did not ask for.
describe("paste attributes: camera motion", () => {
	/** The target: a different look and a different span, on purpose. */
	const CAMERA_MOTION_DST: CameraMotionRegion = {
		id: "cammotion_dst",
		startMs: 12000,
		endMs: 18000,
		timing: { leadInSec: 0.2, returnSec: 0.3, easing: "linear" },
		target: {
			layout: "shape",
			shape: "circle",
			position: { x: 0.8, y: 0.5 },
			size: 0.3,
			roundness: 1,
			opacity: 0.5,
		},
	};

	const pasteAttributes = () => press({ key: "v", ctrlKey: true, shiftKey: true });

	it("takes the copied look and timing, keeping the target's id and span", async () => {
		loadDoc(makeDoc({ cameraMotionRegions: [CAMERA_MOTION_SRC, CAMERA_MOTION_DST] }), 5);
		renderShell();

		copyRegion({ kind: "cameraMotion", region: JSON.parse(JSON.stringify(CAMERA_MOTION_SRC)) });
		fireEvent.pointerDown((await screen.findAllByText("Camera Motion"))[1]);
		await pasteAttributes();

		expect(motionRegions()).toHaveLength(2);
		const dst = motionRegions().find(
			(r) => r.id === "cammotion_dst",
		) as unknown as typeof CAMERA_MOTION_DST;

		// The authored look and envelope came across...
		expect(dst.target).toEqual(CAMERA_MOTION_SRC.target);
		expect(dst.timing).toEqual(CAMERA_MOTION_SRC.timing);
		// ...and nothing that identifies the target moved.
		expect(dst.id).toBe("cammotion_dst");
		expect(dst.startMs).toBe(12000);
		expect(dst.endMs).toBe(18000);
		// The source is untouched — a properties paste writes one region, not two.
		const src = motionRegions().find(
			(r) => r.id === "cammotion_src",
		) as unknown as typeof CAMERA_MOTION_SRC;
		expect(src.target).toEqual(CAMERA_MOTION_SRC.target);
		expect(src.startMs).toBe(1000);
	});

	it("records exactly one undo step, and redo brings the pasted look back", async () => {
		loadDoc(makeDoc({ cameraMotionRegions: [CAMERA_MOTION_SRC, CAMERA_MOTION_DST] }), 5);
		renderShell();

		copyRegion({ kind: "cameraMotion", region: JSON.parse(JSON.stringify(CAMERA_MOTION_SRC)) });
		fireEvent.pointerDown((await screen.findAllByText("Camera Motion"))[1]);
		await pasteAttributes();

		const after = motionRegions().find(
			(r) => r.id === "cammotion_dst",
		) as unknown as typeof CAMERA_MOTION_DST;
		expect(after.target).toEqual(CAMERA_MOTION_SRC.target);

		// ONE undo must be enough — the store writes target and timing in a single save.
		await act(async () => {
			await undo();
		});
		const undone = motionRegions().find(
			(r) => r.id === "cammotion_dst",
		) as unknown as typeof CAMERA_MOTION_DST;
		expect(undone.target).toEqual(CAMERA_MOTION_DST.target);
		expect(undone.timing).toEqual(CAMERA_MOTION_DST.timing);

		await act(async () => {
			await redo();
		});
		const redone = motionRegions().find(
			(r) => r.id === "cammotion_dst",
		) as unknown as typeof CAMERA_MOTION_DST;
		expect(redone.target).toEqual(CAMERA_MOTION_SRC.target);
	});

	it("refuses a cross-kind paste and leaves the document alone", async () => {
		loadDoc(makeDoc({ screenMotionRegions: [SCREEN_MOTION_SRC] }), 5);
		renderShell();

		copyRegion({ kind: "cameraMotion", region: JSON.parse(JSON.stringify(CAMERA_MOTION_SRC)) });
		fireEvent.pointerDown(await screen.findByText("Screen Motion"));
		await pasteAttributes();

		expect(screenRegions()).toHaveLength(1);
		const only = screenRegions()[0] as unknown as typeof SCREEN_MOTION_SRC;
		expect(only.target).toEqual(SCREEN_MOTION_SRC.target);
		expect(toastError).toHaveBeenCalled();
	});

	it("does nothing with an empty clipboard", async () => {
		loadDoc(makeDoc({ cameraMotionRegions: [CAMERA_MOTION_DST] }), 5);
		renderShell();

		fireEvent.pointerDown(await screen.findByText("Camera Motion"));
		await pasteAttributes();

		const only = motionRegions()[0] as unknown as typeof CAMERA_MOTION_DST;
		expect(only.target).toEqual(CAMERA_MOTION_DST.target);
		expect(toastError).toHaveBeenCalled();
	});

	it("does nothing when no move is selected", async () => {
		loadDoc(makeDoc({ cameraMotionRegions: [CAMERA_MOTION_DST] }), 5);
		renderShell();

		copyRegion({ kind: "cameraMotion", region: JSON.parse(JSON.stringify(CAMERA_MOTION_SRC)) });
		await pasteAttributes();

		const only = motionRegions()[0] as unknown as typeof CAMERA_MOTION_DST;
		expect(only.target).toEqual(CAMERA_MOTION_DST.target);
	});

	it("leaves the plain Ctrl+V behaviour alone", async () => {
		loadDoc(makeDoc({ cameraMotionRegions: [CAMERA_MOTION_DST] }), 5);
		renderShell();

		copyRegion({ kind: "cameraMotion", region: JSON.parse(JSON.stringify(CAMERA_MOTION_SRC)) });
		fireEvent.pointerDown(await screen.findByText("Camera Motion"));
		await paste();

		// A SECOND region, and the selected one still carries its own look.
		expect(motionRegions()).toHaveLength(2);
		const dst = motionRegions().find(
			(r) => r.id === "cammotion_dst",
		) as unknown as typeof CAMERA_MOTION_DST;
		expect(dst.target).toEqual(CAMERA_MOTION_DST.target);
	});
});

describe("paste attributes: screen motion and focus effect", () => {
	const SCREEN_MOTION_DST: ScreenMotionRegion = {
		id: "screenmotion_dst",
		startMs: 12000,
		endMs: 18000,
		timing: { leadInSec: 0.2, returnSec: 0.3, easing: "linear" },
		target: {
			position: { x: 0.2, y: 0.8 },
			scale: 1,
			rotationX: 0,
			rotationY: 0,
			rotationZ: 0,
			perspective: 0.2,
		},
	};

	/** A source that carries a spotlight — the effect must travel with the target. */
	const SCREEN_MOTION_WITH_FOCUS: ScreenMotionRegion = {
		...SCREEN_MOTION_SRC,
		id: "screenmotion_focus_src",
		focusEffect: {
			shape: "radial",
			angleDegrees: 0,
			target: "fixed",
			center: { x: 0.3, y: 0.7 },
			size: 0.2,
			softness: 0.4,
			dimming: 0.7,
		},
	};

	const pasteAttributes = () => press({ key: "v", ctrlKey: true, shiftKey: true });

	it("takes the copied target and timing, keeping the target's id and span", async () => {
		loadDoc(makeDoc({ screenMotionRegions: [SCREEN_MOTION_SRC, SCREEN_MOTION_DST] }), 5);
		renderShell();

		copyRegion({ kind: "screenMotion", region: JSON.parse(JSON.stringify(SCREEN_MOTION_SRC)) });
		fireEvent.pointerDown((await screen.findAllByText("Screen Motion"))[1]);
		await pasteAttributes();

		const dst = screenRegions().find(
			(r) => r.id === "screenmotion_dst",
		) as unknown as typeof SCREEN_MOTION_DST;
		expect(dst.target).toEqual(SCREEN_MOTION_SRC.target);
		expect(dst.timing).toEqual(SCREEN_MOTION_SRC.timing);
		expect(dst.id).toBe("screenmotion_dst");
		expect(dst.startMs).toBe(12000);
		expect(dst.endMs).toBe(18000);
	});

	it("carries a focus effect across, and clears one the source does not have", async () => {
		loadDoc(makeDoc({ screenMotionRegions: [SCREEN_MOTION_WITH_FOCUS, SCREEN_MOTION_DST] }), 5);
		renderShell();

		// Source HAS a spotlight -> the target gets it.
		copyRegion({
			kind: "screenMotion",
			region: JSON.parse(JSON.stringify(SCREEN_MOTION_WITH_FOCUS)),
		});
		fireEvent.pointerDown((await screen.findAllByText("Screen Motion"))[1]);
		await pasteAttributes();

		const withFocus = screenRegions().find(
			(r) => r.id === "screenmotion_dst",
		) as unknown as typeof SCREEN_MOTION_WITH_FOCUS;
		expect(withFocus.focusEffect).toEqual(SCREEN_MOTION_WITH_FOCUS.focusEffect);

		// Source has NO spotlight -> the target's is cleared, not silently kept.
		copyRegion({ kind: "screenMotion", region: JSON.parse(JSON.stringify(SCREEN_MOTION_SRC)) });
		await pasteAttributes();

		const cleared = screenRegions().find(
			(r) => r.id === "screenmotion_dst",
		) as unknown as typeof SCREEN_MOTION_DST;
		expect(cleared.focusEffect).toBeUndefined();
		expect(cleared.target).toEqual(SCREEN_MOTION_SRC.target);
	});

	it("survives save and reopen", async () => {
		loadDoc(makeDoc({ screenMotionRegions: [SCREEN_MOTION_SRC, SCREEN_MOTION_DST] }), 5);
		renderShell();

		copyRegion({ kind: "screenMotion", region: JSON.parse(JSON.stringify(SCREEN_MOTION_SRC)) });
		fireEvent.pointerDown((await screen.findAllByText("Screen Motion"))[1]);
		await pasteAttributes();

		// Whatever was handed to the bridge is what a reopen would read back.
		const saved = bridgeMocks.save.mock.calls.at(-1)?.[0] as AxcutDocument | undefined;
		expect(saved).toBeTruthy();
		const reloaded = saved?.screenMotionRegions.find(
			(r) => r.id === "screenmotion_dst",
		) as unknown as typeof SCREEN_MOTION_DST;
		expect(reloaded.target).toEqual(SCREEN_MOTION_SRC.target);
		expect(reloaded.startMs).toBe(12000);
	});
});

// The store's `saveDocument` resolves `false` on a handled failure (a read-only project, a
// disk error) and the caller reads that as "the edit did not happen". A properties paste is
// no exception: announcing success over a write that landed nothing is worse here than
// elsewhere, because the user's only evidence would be the toast — the region on screen
// still shows its old look, and they would read that as the paste being broken.
describe("paste attributes: a failed save", () => {
	const CAMERA_MOTION_DST: CameraMotionRegion = {
		id: "cammotion_dst",
		startMs: 12000,
		endMs: 18000,
		timing: { leadInSec: 0.2, returnSec: 0.3, easing: "linear" },
		target: {
			layout: "shape",
			shape: "circle",
			position: { x: 0.8, y: 0.5 },
			size: 0.3,
			roundness: 1,
			opacity: 0.5,
		},
	};

	const pasteAttributes = () => press({ key: "v", ctrlKey: true, shiftKey: true });

	it("never announces success when the write failed", async () => {
		loadDoc(makeDoc({ cameraMotionRegions: [CAMERA_MOTION_SRC, CAMERA_MOTION_DST] }), 5);
		renderShell();

		bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "disk full" });

		copyRegion({ kind: "cameraMotion", region: JSON.parse(JSON.stringify(CAMERA_MOTION_SRC)) });
		fireEvent.pointerDown((await screen.findAllByText("Camera Motion"))[1]);
		await pasteAttributes();

		// The one assertion that matters: no success toast over a write that did not land.
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(toastError).toHaveBeenCalled();
		// The document is left as it was — a failed write installs nothing.
		const dst = motionRegions().find(
			(r) => r.id === "cammotion_dst",
		) as unknown as typeof CAMERA_MOTION_DST;
		expect(dst.target).toEqual(CAMERA_MOTION_DST.target);
	});

	it("does not leave a half-applied undo step behind", async () => {
		loadDoc(makeDoc({ cameraMotionRegions: [CAMERA_MOTION_SRC, CAMERA_MOTION_DST] }), 5);
		renderShell();

		bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "disk full" });

		copyRegion({ kind: "cameraMotion", region: JSON.parse(JSON.stringify(CAMERA_MOTION_SRC)) });
		fireEvent.pointerDown((await screen.findAllByText("Camera Motion"))[1]);
		await pasteAttributes();

		// `saveDocument` records history only BELOW the write, so a failed save pushes nothing.
		// An undo after it must therefore be a no-op, not a jump to some half-pasted state.
		await act(async () => {
			await undo();
		});
		const dst = motionRegions().find(
			(r) => r.id === "cammotion_dst",
		) as unknown as typeof CAMERA_MOTION_DST;
		expect(dst.target).toEqual(CAMERA_MOTION_DST.target);
	});
});

// A pill is not a region. Several adjacent regions that share a look render as ONE pill, and
// the user selects the pill — so a properties-paste has to reach every region under it.
// Rewriting only the clicked id would leave the pill with two different looks, and the merge
// rule would then split it in two: an edit asked to change how a pill LOOKS would change how
// many pills there are. `resolvePillIds` is the same call `dropPillById` uses to delete one.
describe("paste attributes: a pill made of several merged regions", () => {
	/** Two adjacent regions with identical look and timing: one pill, two regions. */
	const MERGED_LOOK = {
		layout: "shape" as const,
		shape: "square" as const,
		position: { x: 0.5, y: 0.5 },
		size: 0.4,
		roundness: 0.3,
		opacity: 0.9,
	};
	const MERGED_TIMING = { leadInSec: 0.5, returnSec: 0.5, easing: "linear" as const };
	const MERGED_A: CameraMotionRegion = {
		id: "cammotion_m1",
		startMs: 1000,
		endMs: 2000,
		timing: { ...MERGED_TIMING },
		target: { ...MERGED_LOOK },
	};
	const MERGED_B: CameraMotionRegion = {
		id: "cammotion_m2",
		startMs: 2000,
		endMs: 3000,
		timing: { ...MERGED_TIMING },
		target: { ...MERGED_LOOK },
	};

	const pasteAttributes = () => press({ key: "v", ctrlKey: true, shiftKey: true });
	const byId = (id: string) =>
		motionRegions().find((r) => r.id === id) as unknown as CameraMotionRegion;

	it("updates EVERY region under the pill, keeping each id and span", async () => {
		loadDoc(makeDoc({ cameraMotionRegions: [MERGED_A, MERGED_B, CAMERA_MOTION_SRC] }), 5);
		renderShell();

		copyRegion({ kind: "cameraMotion", region: JSON.parse(JSON.stringify(CAMERA_MOTION_SRC)) });
		// One pill renders for the merged pair, so index 0 is that pill.
		fireEvent.pointerDown((await screen.findAllByText("Camera Motion"))[0]);
		await pasteAttributes();

		// Still three regions — the paste rewrote them, it did not merge or split anything.
		expect(motionRegions()).toHaveLength(3);

		// BOTH halves took the copied look...
		expect(byId("cammotion_m1").target).toEqual(CAMERA_MOTION_SRC.target);
		expect(byId("cammotion_m2").target).toEqual(CAMERA_MOTION_SRC.target);
		expect(byId("cammotion_m1").timing).toEqual(CAMERA_MOTION_SRC.timing);
		expect(byId("cammotion_m2").timing).toEqual(CAMERA_MOTION_SRC.timing);

		// ...and neither moved.
		expect(byId("cammotion_m1").startMs).toBe(1000);
		expect(byId("cammotion_m1").endMs).toBe(2000);
		expect(byId("cammotion_m2").startMs).toBe(2000);
		expect(byId("cammotion_m2").endMs).toBe(3000);
		expect(toastSuccess).toHaveBeenCalledTimes(1);
	});

	it("records ONE undo step for the whole pill, and redo restores every region", async () => {
		loadDoc(makeDoc({ cameraMotionRegions: [MERGED_A, MERGED_B] }), 5);
		renderShell();

		copyRegion({ kind: "cameraMotion", region: JSON.parse(JSON.stringify(CAMERA_MOTION_SRC)) });
		fireEvent.pointerDown((await screen.findAllByText("Camera Motion"))[0]);
		await pasteAttributes();
		expect(byId("cammotion_m1").target).toEqual(CAMERA_MOTION_SRC.target);
		expect(byId("cammotion_m2").target).toEqual(CAMERA_MOTION_SRC.target);

		await act(async () => {
			await undo();
		});
		// One undo is enough for the pair.
		expect(byId("cammotion_m1").target).toEqual(MERGED_LOOK);
		expect(byId("cammotion_m2").target).toEqual(MERGED_LOOK);

		await act(async () => {
			await redo();
		});
		expect(byId("cammotion_m1").target).toEqual(CAMERA_MOTION_SRC.target);
		expect(byId("cammotion_m2").target).toEqual(CAMERA_MOTION_SRC.target);
	});

	it("carries a focus effect to every region under a merged screen pill", async () => {
		const look = {
			position: { x: 0.5, y: 0.5 },
			scale: 1.2,
			rotationX: 0,
			rotationY: 0,
			rotationZ: 0,
			perspective: 0.3,
		};
		const timing = { leadInSec: 0.5, returnSec: 0.5, easing: "linear" as const };
		const s1: ScreenMotionRegion = {
			id: "screenmotion_n1",
			startMs: 1000,
			endMs: 2000,
			timing: { ...timing },
			target: { ...look },
		};
		const s2: ScreenMotionRegion = {
			id: "screenmotion_n2",
			startMs: 2000,
			endMs: 3000,
			timing: { ...timing },
			target: { ...look },
		};
		const src: ScreenMotionRegion = {
			...SCREEN_MOTION_SRC,
			id: "screenmotion_fsrc",
			focusEffect: {
				shape: "radial",
				angleDegrees: 0,
				target: "fixed",
				center: { x: 0.25, y: 0.75 },
				size: 0.3,
				softness: 0.2,
				dimming: 0.6,
			},
		};
		loadDoc(makeDoc({ screenMotionRegions: [s1, s2, src] }), 5);
		renderShell();

		copyRegion({ kind: "screenMotion", region: JSON.parse(JSON.stringify(src)) });
		fireEvent.pointerDown((await screen.findAllByText("Screen Motion"))[0]);
		await pasteAttributes();

		const n1 = screenRegions().find(
			(r) => r.id === "screenmotion_n1",
		) as unknown as ScreenMotionRegion;
		const n2 = screenRegions().find(
			(r) => r.id === "screenmotion_n2",
		) as unknown as ScreenMotionRegion;
		expect(n1.focusEffect).toEqual(src.focusEffect);
		expect(n2.focusEffect).toEqual(src.focusEffect);
		expect(n1.target).toEqual(SCREEN_MOTION_SRC.target);
		expect(n2.target).toEqual(SCREEN_MOTION_SRC.target);
		expect(n1.startMs).toBe(1000);
		expect(n2.endMs).toBe(3000);
	});

	it("does not split a pill into two when only one half would have changed", async () => {
		// A paste that reached only `cammotion_m1` would leave the two halves with different
		// looks — the merge rule would then render them as two pills. Asserting the count
		// afterwards is what catches that: the pair must still be ONE pill.
		loadDoc(makeDoc({ cameraMotionRegions: [MERGED_A, MERGED_B] }), 5);
		renderShell();

		copyRegion({ kind: "cameraMotion", region: JSON.parse(JSON.stringify(CAMERA_MOTION_SRC)) });
		fireEvent.pointerDown((await screen.findAllByText("Camera Motion"))[0]);
		await pasteAttributes();

		const { coalesceRegionsForRuler } = await import("@/lib/ai-edition/timeline/timelineMap");
		expect(coalesceRegionsForRuler(motionRegions())).toHaveLength(1);
	});
});

// The three ways a properties-paste can decline are three different things to tell the user.
// A boolean flattened them, and the caller reported "not the same kind of move" over all of
// them — including over a write that had already raised its own failure toast.
describe("paste attributes: which message for which outcome", () => {
	const DST: CameraMotionRegion = {
		id: "cammotion_dst",
		startMs: 12000,
		endMs: 18000,
		timing: { leadInSec: 0.2, returnSec: 0.3, easing: "linear" },
		target: {
			layout: "shape",
			shape: "circle",
			position: { x: 0.8, y: 0.5 },
			size: 0.3,
			roundness: 1,
			opacity: 0.5,
		},
	};
	const pasteAttributes = () => press({ key: "v", ctrlKey: true, shiftKey: true });
	// The shell also toasts unrelated startup noise in jsdom ("Could not auto-create project
	// from recording"), so counting every `toast.error` would measure that instead of the
	// paste. Counting the keys this feature owns is what makes the count meaningful.
	const ownErrors = (key: string) => toastError.mock.calls.filter(([k]) => k === key).length;

	it("kind mismatch: says so, exactly once", async () => {
		loadDoc(makeDoc({ screenMotionRegions: [SCREEN_MOTION_SRC] }), 5);
		renderShell();

		copyRegion({ kind: "cameraMotion", region: JSON.parse(JSON.stringify(CAMERA_MOTION_SRC)) });
		fireEvent.pointerDown(await screen.findByText("Screen Motion"));
		await pasteAttributes();

		expect(ownErrors("regionClipboard.pasteAttributesKindMismatch")).toBe(1);
		expect(ownErrors("regionClipboard.pasteAttributesNoTarget")).toBe(0);
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it("no actual change: silent, no write, no undo step, and NOT a kind mismatch", async () => {
		loadDoc(makeDoc({ cameraMotionRegions: [CAMERA_MOTION_SRC] }), 5);
		renderShell();

		// Copy the very region that is selected: the paste would change nothing.
		copyRegion({ kind: "cameraMotion", region: JSON.parse(JSON.stringify(CAMERA_MOTION_SRC)) });
		fireEvent.pointerDown(await screen.findByText("Camera Motion"));
		await pasteAttributes();

		// Neither message. Reporting a kind mismatch here named a cause that was not the cause.
		expect(ownErrors("regionClipboard.pasteAttributesKindMismatch")).toBe(0);
		expect(ownErrors("regionClipboard.pasteAttributesNoTarget")).toBe(0);
		expect(toastSuccess).not.toHaveBeenCalled();
		// And no undo step was pushed for an edit that did not happen.
		const before = motionRegions()[0] as unknown as CameraMotionRegion;
		await act(async () => {
			await undo();
		});
		const after = motionRegions()[0] as unknown as CameraMotionRegion;
		expect(after.target).toEqual(before.target);
	});

	it("bridge save failure: the failure is reported once, and not as a kind mismatch", async () => {
		loadDoc(makeDoc({ cameraMotionRegions: [CAMERA_MOTION_SRC, DST] }), 5);
		renderShell();

		bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "disk full" });

		copyRegion({ kind: "cameraMotion", region: JSON.parse(JSON.stringify(CAMERA_MOTION_SRC)) });
		fireEvent.pointerDown((await screen.findAllByText("Camera Motion"))[1]);
		await pasteAttributes();

		// `saveDocument` raises the real failure; the paste must not add a kind-mismatch line
		// on top of it, and must not claim success.
		expect(toastSuccess).not.toHaveBeenCalled();
		// The real failure is `saveDocument`'s own toast; what this asserts is that the paste
		// added nothing on top of it, and in particular did not misname the cause.
		expect(ownErrors("regionClipboard.pasteAttributesKindMismatch")).toBe(0);
		// And the failure itself WAS reported — `saveDocument` raises it through `toastText`,
		// which returns the translated sentence rather than the key, so the check is that
		// some error toast happened rather than that a particular string was passed.
		expect(toastError).toHaveBeenCalled();
	});
});
