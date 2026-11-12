// Recording markers — editorial bookmarks the user drops while recording, kept as
// points on the RECORDING's source time.
//
// Why source time and not a ruler position: a marker's whole job is to point at a moment
// in the take ("I fluffed this line", "the good bit starts here"). The ruler it is drawn
// on moves under it — a trim removes footage ahead of it, a reorder slides its clip, a
// retime rescales the run — so a marker stored in ruler seconds would drift off the
// moment it was dropped for. Source time is the one coordinate none of those edits
// change, which is why `RecordingMarker.sourceTime` is also what DogSC anchors to.
//
// Nothing here mutates the document in place, and nothing here DROPS a marker for being
// out of view: a trim that hides a marker must be undoable back into showing it, so
// visibility is computed per read (`visibleMarkers`) and the stored marker is left
// exactly as the user dropped it. That is the one place this deliberately parts company
// with the region collections, where `rederiveRegionMs` prunes a region whose source
// window is gone — a region acts on footage, so losing the footage loses the region; a
// marker is a note ABOUT a moment, and only the user deletes it.

import type { RecordingMarkerInput } from "../../recordingSession";
import type { AxcutClip, AxcutDocument, AxcutRecordingMarker } from "../schema";
import { createId } from "./ids";

/** Readable in a stored document and grep-friendly, like every other id in the schema. */
export const MARKER_ID_PREFIX = "marker";

export interface MarkerDrop {
	/** The asset the take became. Absent while the marker is still in the recording
	 *  session, before the editor has minted an asset to hang it on. */
	assetId?: string;
	/** Seconds into the recording, pause-aware — the value the HUD read off its own
	 *  elapsed clock when the button was pressed. */
	sourceTimeSec: number;
	label?: string;
	/** ISO timestamp, injectable so tests do not race the wall clock. */
	createdAt?: string;
}

export function createMarker(drop: MarkerDrop): AxcutRecordingMarker {
	const sourceTimeSec = Number.isFinite(drop.sourceTimeSec) ? Math.max(0, drop.sourceTimeSec) : 0;
	return {
		id: createId(MARKER_ID_PREFIX),
		...(drop.assetId ? { assetId: drop.assetId } : {}),
		sourceTimeSec,
		label: drop.label ?? "",
		createdAt: drop.createdAt ?? new Date().toISOString(),
	};
}

/**
 * Whether a clip currently draws the given source second.
 *
 * The extent is read literally, including the 60s seed a clip carries before its media has
 * been probed. It is tempting to treat that seed as open-ended so a marker deep in a long
 * take shows up immediately — but the ruler is only as long as the clips on it, so a second
 * past a clip's end has no position to be drawn at, and the generous reading instead maps
 * the marker onto whatever clip happens to look open-ended. A marker past the seed is
 * therefore simply not shown until the probe extends the clip, which is the same moment the
 * ruler grows to where the marker belongs.
 */
function clipCoversSource(clip: AxcutClip, sourceTimeSec: number): boolean {
	if (sourceTimeSec < clip.sourceStartSec) return false;
	const end = clip.sourceEndSec;
	return end !== undefined && end > clip.sourceStartSec && sourceTimeSec < end;
}

/**
 * The RAW-ruler second a marker is drawn at right now, or `null` when nothing on the
 * timeline currently shows that source second.
 *
 * `null` is the whole visibility rule, and it is a pure function of the clip layout, so
 * it is reversible by construction: trim the marker's second away and it stops resolving;
 * restore the trim and the same stored marker resolves again, with no bookkeeping.
 *
 * A raw clip is identity between source and ruler time (its length is its source length —
 * no speed baked into the geometry), so within one clip this is a plain shift by the
 * clip's own start offset. See `timeline/timelineMap.ts` for the three coordinate systems
 * this bridges.
 *
 * Two clips can draw the same source second only when the take was DUPLICATED (`duplicateClip`),
 * and then the EARLIEST copy wins. Picking the earliest is what makes the answer independent
 * of the order the clips happen to sit in the array, and one tick per marker is the right
 * number: a bookmark is one moment, and the second copy of the footage is the same moment
 * seen twice. It is a choice, not an accident — see the duplicate case in the tests.
 */
export function markerRawTimeSec(
	marker: Pick<AxcutRecordingMarker, "assetId" | "sourceTimeSec">,
	clips: readonly AxcutClip[],
): number | null {
	let earliest: number | null = null;
	for (const clip of clips) {
		// An unbound marker (still in the recording session) matches any clip — it has no
		// asset to disagree with, and the import binds it to one before the editor draws it.
		if (marker.assetId !== undefined && clip.assetId !== marker.assetId) continue;
		if (!clipCoversSource(clip, marker.sourceTimeSec)) continue;
		const rawTimeSec = clip.timelineStartSec + (marker.sourceTimeSec - clip.sourceStartSec);
		if (earliest === null || rawTimeSec < earliest) earliest = rawTimeSec;
	}
	return earliest;
}

export interface VisibleMarker {
	marker: AxcutRecordingMarker;
	/** RAW-ruler second to draw at. */
	rawTimeSec: number;
}

/** Every marker the current clip layout shows, in ruler order. Markers trimmed out of
 *  view are absent here and untouched in the document. */
export function visibleMarkers(document: AxcutDocument): VisibleMarker[] {
	return visibleMarkersFor(document.markers, document.timeline.clips);
}

/**
 * The same answer from the two collections a caller already holds. The timeline reads its
 * markers and clips off the store rather than the whole document, and both entry points
 * have to agree — so the rule lives here once and `visibleMarkers` is the document-shaped
 * wrapper around it.
 */
export function visibleMarkersFor(
	markers: readonly AxcutRecordingMarker[],
	clips: readonly AxcutClip[],
): VisibleMarker[] {
	return markers
		.map((marker) => {
			const rawTimeSec = markerRawTimeSec(marker, clips);
			return rawTimeSec === null ? null : { marker, rawTimeSec };
		})
		.filter((entry): entry is VisibleMarker => entry !== null)
		.sort((a, b) =>
			a.rawTimeSec === b.rawTimeSec
				? a.marker.sourceTimeSec - b.marker.sourceTimeSec
				: a.rawTimeSec - b.rawTimeSec,
		);
}

/** Source-time order, the order a marker list is stored and shown in the session. */
export function sortMarkers(markers: AxcutRecordingMarker[]): AxcutRecordingMarker[] {
	return [...markers].sort((a, b) => a.sourceTimeSec - b.sourceTimeSec);
}

export function addMarker(document: AxcutDocument, drop: MarkerDrop): AxcutDocument {
	return { ...document, markers: sortMarkers([...document.markers, createMarker(drop)]) };
}

export function removeMarker(document: AxcutDocument, id: string): AxcutDocument {
	const markers = document.markers.filter((marker) => marker.id !== id);
	if (markers.length === document.markers.length) return document;
	return { ...document, markers };
}

export function setMarkerLabel(document: AxcutDocument, id: string, label: string): AxcutDocument {
	let changed = false;
	const markers = document.markers.map((marker) => {
		if (marker.id !== id || marker.label === label) return marker;
		changed = true;
		return { ...marker, label };
	});
	return changed ? { ...document, markers } : document;
}

/**
 * Session markers → stored markers. The session carries the WIRE shape: `label` and
 * `createdAt` are optional there because a marker can arrive from a `.session.json` that a
 * build with less to say about it wrote. The document's shape is exact, so the gaps are
 * filled here rather than left for every reader to cope with.
 */
export function markersFromSession(
	incoming: readonly RecordingMarkerInput[],
	fallbackCreatedAt: string,
): AxcutRecordingMarker[] {
	return incoming.map((marker) => ({
		id: marker.id,
		sourceTimeSec: Number.isFinite(marker.sourceTimeSec) ? Math.max(0, marker.sourceTimeSec) : 0,
		label: marker.label ?? "",
		createdAt: marker.createdAt ?? fallbackCreatedAt,
	}));
}

/**
 * Adopt markers that arrived from the recording session: give each one the asset the take
 * became, keep the ones already carrying an asset id as they are, and merge by id so a
 * re-run of the import cannot double them up.
 */
export function bindMarkersToAsset(
	document: AxcutDocument,
	assetId: string,
	incoming: readonly AxcutRecordingMarker[],
): AxcutDocument {
	if (incoming.length === 0) return document;
	const byId = new Map(document.markers.map((marker) => [marker.id, marker]));
	for (const marker of incoming) {
		byId.set(marker.id, marker.assetId ? marker : { ...marker, assetId });
	}
	return { ...document, markers: sortMarkers([...byId.values()]) };
}

/**
 * Where a marker has to sit in SOURCE time so that it lands at `rawTimeSec` on the timeline.
 *
 * The inverse of `markerRawTimeSec`, and deliberately not a programme-time conversion: markers
 * are stored on the source ruler, and the raw timeline is that ruler plus each clip's offset, so
 * the mapping inside one clip is linear. Speed changes how long a source second *plays*, not
 * where it sits, so a marker does not move when the user speeds a range up.
 *
 * Returns null when no clip on the timeline covers that raw moment — a marker cannot be placed
 * on empty timeline, and guessing the nearest clip would silently bind it to another take.
 */
export function markerSourceTimeAtRawTime(
	document: Pick<AxcutDocument, "timeline">,
	rawTimeSec: number,
	preferredAssetId?: string,
): { assetId: string; sourceTimeSec: number } | null {
	for (const clip of document.timeline.clips) {
		if (rawTimeSec < clip.timelineStartSec || rawTimeSec >= clip.timelineEndSec) continue;
		if (preferredAssetId !== undefined && clip.assetId !== preferredAssetId) continue;
		return {
			assetId: clip.assetId,
			sourceTimeSec: clip.sourceStartSec + (rawTimeSec - clip.timelineStartSec),
		};
	}
	return null;
}

/** Moves one marker to a raw timeline position, keeping its id, label and createdAt. */
export function moveMarkerToRawTime(
	document: AxcutDocument,
	id: string,
	rawTimeSec: number,
): AxcutDocument {
	const marker = (document.markers ?? []).find((m) => m.id === id);
	if (!marker) return document;
	const placed = markerSourceTimeAtRawTime(document, rawTimeSec, marker.assetId);
	if (!placed) return document;
	return {
		...document,
		markers: (document.markers ?? []).map((m) =>
			m.id === id ? { ...m, sourceTimeSec: placed.sourceTimeSec } : m,
		),
	};
}

/**
 * Merges markers that belong to the same take into the earliest of them.
 *
 * Same asset only: two markers from different recordings have no common ruler, so "earliest"
 * would be comparing seconds of one video against seconds of another. The survivor keeps its id
 * (any reference to it stays valid), label and createdAt, and takes the earliest source time.
 */
export function mergeMarkers(document: AxcutDocument, ids: readonly string[]): AxcutDocument {
	const markers = document.markers ?? [];
	const picked = markers.filter((m) => ids.includes(m.id));
	if (picked.length < 2) return document;
	const assetId = picked[0].assetId;
	if (picked.some((m) => m.assetId !== assetId)) return document;
	const keep = picked.reduce((a, b) => (b.sourceTimeSec < a.sourceTimeSec ? b : a));
	const dropIds = new Set(picked.filter((m) => m.id !== keep.id).map((m) => m.id));
	return {
		...document,
		markers: markers
			.filter((m) => !dropIds.has(m.id))
			.map((m) => (m.id === keep.id ? { ...m, sourceTimeSec: keep.sourceTimeSec } : m)),
	};
}
