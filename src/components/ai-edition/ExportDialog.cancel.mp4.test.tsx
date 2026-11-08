// @vitest-environment jsdom
// MP4 cancellation, which did not exist before this round: the Cancel button was disabled for
// the whole render, and only the GIF path had a native handle to stop. These assertions are the
// user-visible half of that gap — the dialog half of "click Cancel and the export stops".
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultOpeningSequence } from "@/lib/ai-edition/opening/opening";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/native", () => ({
	listGpusNative: vi.fn(async () => []),
	exportMultiNative: vi.fn(),
	exportGifNative: vi.fn(),
	cancelExportNative: vi.fn(async () => ({ accepted: true })),
	cancelGifExportNative: vi.fn(async () => ({ accepted: true })),
	useIsCpuCompositor: () => false,
}));
vi.mock("@/native/sceneDescription", () => ({
	buildSceneDescription: () => ({ speedRegions: [] }),
	resolveVisibleClips: (doc: AxcutDocument) => doc.timeline.clips,
}));

import { toast } from "sonner";
import { I18nProvider } from "@/contexts/I18nContext";
import { type AxcutDocument, axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { cancelExportNative, exportMultiNative } from "@/native";
import { NativeBridgeRequestError } from "@/native/client";
import type { CompositorExportResult } from "@/native/contracts";
import { ExportDialog } from "./ExportDialog";

const DOC: AxcutDocument = {
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "proj_mp4_cancel",
		title: "MP4 cancellation",
		createdAt: "2026-11-07T10:00:00Z",
		updatedAt: "2026-11-07T10:00:00Z",
		primaryAssetId: "a1",
	},
	assets: [
		{
			id: "a1",
			kind: "video",
			label: "asset",
			originalPath: "/tmp/a.mp4",
			cameraTrack: null,
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		},
	],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [
			{
				id: "c1",
				assetId: "a1",
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

function pendingExport() {
	let resolve!: (stats: CompositorExportResult) => void;
	let reject!: (error: Error) => void;
	const result = new Promise<CompositorExportResult>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	vi.mocked(exportMultiNative).mockReturnValueOnce(result);
	return { resolve, reject };
}

let onClose: ReturnType<typeof vi.fn<() => void>>;

async function startMp4() {
	const view = render(
		<I18nProvider>
			<ExportDialog open onClose={onClose} document={DOC} />
		</I18nProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
	await waitFor(() => expect(exportMultiNative).toHaveBeenCalledOnce());
	// The id the dialog made up is the sixth argument: protectedPaths (the dialog has none) comes
	// fifth, then the handle.
	const id = vi.mocked(exportMultiNative).mock.calls[0][5];
	expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
	return { ...view, id };
}

describe("MP4 export cancellation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(cancelExportNative).mockResolvedValue({ accepted: true });
		onClose = vi.fn();
		window.electronAPI = {
			getEncoderPrefs: vi.fn(async () => ({ device: "auto" })),
			pickExportSavePath: vi.fn(async () => ({ path: "/tmp/result.mp4" })),
			onNativeExportProgress: vi.fn(() => vi.fn()),
		} as unknown as Window["electronAPI"];
	});
	afterEach(cleanup);

	it("offers Cancel while the render is running", async () => {
		// The whole point of the round: before it, this button was disabled for every MP4 render
		// and the only way out of a long export was to close the window.
		pendingExport();
		await startMp4();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
	});

	it("asks the native side to stop, naming this run's id", async () => {
		pendingExport();
		const { id } = await startMp4();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(cancelExportNative).toHaveBeenCalledWith(id));
		// One request only: a second click must not queue another stop.
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(cancelExportNative).toHaveBeenCalledOnce();
	});

	it("returns to the options when the export settles as cancelled, with no error", async () => {
		const job = pendingExport();
		await startMp4();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(cancelExportNative).toHaveBeenCalled());

		await act(async () =>
			job.reject(
				new NativeBridgeRequestError({
					code: "CANCELLED",
					message: "Export cancelled.",
					retryable: false,
				}),
			),
		);

		expect(screen.getByRole("button", { name: "Export MP4" })).toBeEnabled();
		expect(screen.getByRole("dialog")).toBeVisible();
		expect(onClose).not.toHaveBeenCalled();
		// A cancel the user asked for is not a failure, so neither toast may fire.
		expect(toast.error).not.toHaveBeenCalled();
		expect(toast.success).not.toHaveBeenCalled();
	});

	it("still reports a genuine failure that happens after a cancel request", async () => {
		const job = pendingExport();
		await startMp4();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(cancelExportNative).toHaveBeenCalled());

		await act(async () => job.reject(new Error("encoder died")));
		expect(toast.error).toHaveBeenCalled();
	});
});
