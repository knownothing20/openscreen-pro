// What `openscreen export` reads from a project file, and the loader for the shape the editor
// saves (the AxcutDocument itself). Kept out of CliExportRunner.tsx so it is testable without a
// renderer: the one thing it needs from the DOM, reading a video's metadata, is passed in.

import {
	normalizeProjectEditor,
	type ProjectEditorState,
} from "@/components/video-editor/projectPersistence";
import type { Dims } from "@/lib/ai-edition/document/outputFormat";
import { type AxcutDocument, parseDocumentFile } from "@/lib/ai-edition/schema";

/** Reads a video file's dimensions and duration. */
export type VideoProbe = (
	videoPath: string,
) => Promise<{ width: number; height: number; durationMs: number }>;

/** What the export reads from a project file, whichever shape it was saved in. */
export interface ExportProject {
	document: AxcutDocument;
	/** The v2 editor fields the export reads: format, quality and the GIF settings. */
	editor: ProjectEditorState;
	/** The primary screen recording, where `--auto-zoom` looks up the cursor telemetry. */
	screenVideoPath: string;
	/** Its length in ms, the span `--auto-zoom` suggests zooms over. */
	durationMs: number;
	/** The output size when no clip on the timeline reports one. */
	sourceDims: Dims;
}

/**
 * A project the editor saved: the AxcutDocument itself, at any `schemaVersion`, upgraded and
 * validated as the editor's "Browse files…" does. The main process has already relinked moved
 * media and granted the paths the document declares, as when the editor opens it. Its assets
 * carry their own dimensions and duration, so nothing is migrated and nothing is probed unless
 * an asset lacks them.
 *
 * The ExportDialog keeps format, quality and the GIF settings in its own state, not in the
 * document: they are read from `legacyEditor` when a migrated v2 project left them there, and
 * otherwise take the same defaults as a v2 project. The command-line flags win either way.
 */
export async function loadDocumentProject(raw: unknown, probe: VideoProbe): Promise<ExportProject> {
	const document = parseDocumentFile(raw);
	const primary =
		document.assets.find((asset) => asset.id === document.project.primaryAssetId) ??
		document.assets[0];
	if (!primary?.originalPath) {
		throw new Error("Project file does not reference any recorded media");
	}
	const { video, durationSec } = primary;
	const known = video && video.width > 0 && video.height > 0 && (durationSec ?? 0) > 0;
	const probed = known ? null : await probe(primary.originalPath);
	return {
		document,
		editor: normalizeProjectEditor((document.legacyEditor ?? {}) as Partial<ProjectEditorState>),
		screenVideoPath: primary.originalPath,
		durationMs: probed ? probed.durationMs : (durationSec ?? 0) * 1000,
		sourceDims: probed
			? { width: probed.width, height: probed.height }
			: { width: video?.width ?? 0, height: video?.height ?? 0 },
	};
}

/**
 * Every path a CLI export READS, and therefore must never become the destination of.
 *
 * `exportMulti` already knows the clips it renders and derives its own protected list from
 * them. What it cannot know is the two files this runner reads AROUND the render: the
 * voiceover it mixes in afterwards and the project it was told to export. Those are spelled
 * out here and handed to the native export, so the check happens BEFORE the encoder opens
 * anything.
 *
 * That ordering is the whole point. Without it, `--out` pointing at the voiceover passes the
 * clip-only check, the native pass overwrites the voiceover with the freshly rendered video,
 * and only the mix's write-back notices — after the file it was about to read is gone. Caught
 * on a real run: the source hash changed and the error arrived from the wrong layer.
 */
export function exportedInputPaths(
	request: { audioPath?: string | null; projectPath?: string | null },
	clips: ReadonlyArray<{ screenPath?: string; webcamPath?: string }>,
): string[] {
	const paths = [
		...clips.flatMap((clip) => [clip.screenPath, clip.webcamPath]),
		request.audioPath,
		request.projectPath,
	];
	return paths.filter(
		(candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
	);
}
