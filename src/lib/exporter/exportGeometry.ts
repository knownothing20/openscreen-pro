import {
	collectEffectiveClipDims,
	pickExtremeDims,
	referenceClipDims,
} from "@/lib/ai-edition/document/outputFormat";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { calculateMp4ExportSettings } from "./mp4ExportSettings";
import type { ExportQuality } from "./types";

/**
 * The size an export will actually produce.
 *
 * Extracted so the settings screen's encoder test can encode at the same dimensions the export
 * will use. It used to test at a fixed 1280×720, which is why CPU HEVC reported success and then
 * failed at 1598×1080 — a test that does not share the export's geometry is not testing the
 * export.
 *
 * Same inputs as `ExportDialog`: the smallest clip's cropped footprint (so "source" never
 * upscales), the timeline's aspect ratio, and the frame rate.
 */
export interface ExportGeometry {
	width: number;
	height: number;
	/** Bits per second the export would target. */
	bitrate: number;
}

export function resolveExportGeometry(
	document: AxcutDocument | null,
	quality: ExportQuality,
	fps: number,
	aspectRatioValue: number,
): ExportGeometry | null {
	if (!document) return null;
	const smallest =
		pickExtremeDims(collectEffectiveClipDims(document), "smallest") ?? referenceClipDims(document);
	if (!smallest) return null;
	const settings = calculateMp4ExportSettings({
		quality,
		sourceWidth: smallest.width,
		sourceHeight: smallest.height,
		aspectRatioValue,
		frameRate: fps,
	});
	return { width: settings.width, height: settings.height, bitrate: settings.bitrate };
}
