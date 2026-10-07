export interface ProjectMedia {
	screenVideoPath: string;
	webcamVideoPath?: string;
	/**
	 * Milliseconds to shift the webcam asset's playback position relative to
	 * the screen recording. Negative when the webcam started capturing before
	 * the screen recording's real start (e.g. the browser MediaRecorder for
	 * the webcam is started in the renderer before the native Windows helper
	 * process finishes spawning and confirms recording), so the editor skips
	 * that much extra leading footage instead of showing stale camera frames.
	 */
	webcamOffsetMs?: number;
	cursorCaptureMode?: CursorCaptureMode;
}

export type CursorCaptureMode = "editable-overlay" | "system";

/**
 * A bookmark dropped during recording, as it travels from the HUD to the editor.
 *
 * Deliberately not the document's `AxcutRecordingMarker`: a marker is born before the
 * project exists, so it has no asset to point at yet — the editor binds it on import
 * (`bindMarkersToAsset`). Keeping the shape here also keeps this module dependency-free,
 * which matters because the main process imports it too.
 */
export interface RecordingMarkerInput {
	id: string;
	/** Seconds into the recording, pause-aware — the HUD's own elapsed clock. */
	sourceTimeSec: number;
	label?: string;
	createdAt?: string;
}

export interface RecordingSession extends ProjectMedia {
	createdAt: number;
	/** Markers dropped while this take was recording. Absent for a take with none, and for
	 *  every `.session.json` written before markers existed. */
	markers?: RecordingMarkerInput[];
}

/**
 * What the HUD sends when the marker control is used: the second it read off its own
 * clock, and nothing else. The id and the timestamp are minted in main, so a marker has
 * exactly one author and the HUD never has to know the stored shape.
 */
export interface RecordingMarkerDropInput {
	sourceTimeSec: number;
	label?: string;
}

export interface RecordedVideoAssetInput {
	fileName: string;
	videoData: ArrayBuffer;
}

export interface StoreRecordedSessionInput {
	screen: RecordedVideoAssetInput;
	webcam?: RecordedVideoAssetInput;
	createdAt?: number;
	cursorCaptureMode?: CursorCaptureMode;
	/**
	 * Recording wall-clock duration (ms). The main process patches the WebM Duration
	 * header on streamed recordings (the renderer no longer holds the bytes). Browser
	 * MediaRecorder writes no/zero duration, which breaks the editor seek bar and
	 * timeline for anything that took the streaming path.
	 */
	durationMs?: number;
	/** See {@link ProjectMedia.webcamOffsetMs}. */
	webcamOffsetMs?: number;
}

export function normalizeCursorCaptureMode(value: unknown): CursorCaptureMode | undefined {
	return value === "editable-overlay" || value === "system" ? value : undefined;
}

function normalizePath(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

export function normalizeProjectMedia(candidate: unknown): ProjectMedia | null {
	if (!candidate || typeof candidate !== "object") {
		return null;
	}

	const raw = candidate as Partial<ProjectMedia>;
	const screenVideoPath = normalizePath(raw.screenVideoPath);

	if (!screenVideoPath) {
		return null;
	}

	const webcamVideoPath = normalizePath(raw.webcamVideoPath);
	const cursorCaptureMode = normalizeCursorCaptureMode(raw.cursorCaptureMode);
	const webcamOffsetMs =
		typeof raw.webcamOffsetMs === "number" && Number.isFinite(raw.webcamOffsetMs)
			? raw.webcamOffsetMs
			: undefined;

	return {
		screenVideoPath,
		...(webcamVideoPath ? { webcamVideoPath } : {}),
		...(webcamOffsetMs !== undefined ? { webcamOffsetMs } : {}),
		...(cursorCaptureMode ? { cursorCaptureMode } : {}),
	};
}

/**
 * Keep a marker only if it can be drawn: an id to address it by and a finite, non-negative
 * second to place it at. Dropped rather than rejected, because the alternative is refusing
 * to open a take over a bookmark.
 */
export function normalizeRecordingMarkerInput(candidate: unknown): RecordingMarkerInput | null {
	if (!candidate || typeof candidate !== "object") return null;
	const raw = candidate as Partial<RecordingMarkerInput>;
	if (typeof raw.id !== "string" || !raw.id) return null;
	if (typeof raw.sourceTimeSec !== "number" || !Number.isFinite(raw.sourceTimeSec)) return null;
	return {
		id: raw.id,
		sourceTimeSec: Math.max(0, raw.sourceTimeSec),
		...(typeof raw.label === "string" ? { label: raw.label } : {}),
		...(typeof raw.createdAt === "string" ? { createdAt: raw.createdAt } : {}),
	};
}

function normalizeRecordingMarkers(candidate: unknown): RecordingMarkerInput[] | undefined {
	if (!Array.isArray(candidate)) return undefined;
	const markers: RecordingMarkerInput[] = [];
	for (const entry of candidate) {
		const marker = normalizeRecordingMarkerInput(entry);
		if (marker) markers.push(marker);
	}
	return markers.length > 0 ? markers : undefined;
}

export function normalizeRecordingSession(candidate: unknown): RecordingSession | null {
	if (!candidate || typeof candidate !== "object") {
		return null;
	}

	const raw = candidate as Partial<RecordingSession>;
	const media = normalizeProjectMedia(raw);
	if (!media) {
		return null;
	}

	const markers = normalizeRecordingMarkers(raw.markers);
	return {
		...media,
		createdAt:
			typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
				? raw.createdAt
				: Date.now(),
		...(markers ? { markers } : {}),
	};
}
