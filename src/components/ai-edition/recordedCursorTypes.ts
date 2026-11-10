import { useEffect, useMemo, useReducer, useState } from "react";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { resolveClipSourceEndSec } from "@/lib/ai-edition/timeline/clipDuration";
import { nativeBridgeClient } from "@/native";

interface CursorStateChange {
	timeMs: number;
	type: string;
}

/**
 * A recording's cursor states the way the compositor reads them (`CursorTrack::load`): the
 * changes only, and a sample without a state means the arrow.
 */
export function cursorStateChanges(
	samples: ReadonlyArray<{ timeMs: number; cursorType?: string | null }>,
): CursorStateChange[] {
	const changes: CursorStateChange[] = [];
	for (const { timeMs, cursorType } of samples) {
		const type = cursorType || "arrow";
		if (changes.at(-1)?.type !== type) changes.push({ timeMs, type });
	}
	return changes;
}

/**
 * What a sidecar actually lets the editor change.
 *
 * Three separate answers on purpose. The pane used to ask a single question — "does
 * `cursorStateChanges` name more than zero states?" — and that is really the *shape* question. A
 * take recorded through a remote session carries usable positions and clicks but never names a
 * cursor shape (`cursorType` stays null), so the answer came back "no states", `hasCursor` went
 * false, and the whole pane was hidden on footage where every control would have worked. The
 * ripple only needs clicks, the trail and halo only need positions; the sprite pickers need
 * names. See the V2.7.2 report.
 */
export interface CursorDataCapabilities {
	/** At least one sample with a finite, non-negative timestamp and a point inside the frame. */
	position: boolean;
	/** At least one click — the only input the ripple settings act on. */
	clicks: boolean;
	/** At least one named shape (`cursorType`), which the "pick a shape" list needs. */
	shapes: boolean;
}

/** The interactions the compositor draws a ripple for. `move` and `mouseup` are not clicks. */
const CLICK_INTERACTIONS = new Set(["click", "double-click", "right-click", "middle-click"]);

/**
 * Read the three answers off the samples.
 *
 * A sample counts as a position only when the compositor could actually place it: a timestamp it
 * can seek to and a point inside the frame. Anything else would be clipped or would land at a
 * nonsense time, so it must not be what keeps the pane open.
 */
export function cursorCapabilitiesOf(
	samples: ReadonlyArray<{
		timeMs: number;
		cx: number;
		cy: number;
		cursorType?: string | null;
		interactionType?: string | null;
	}>,
): CursorDataCapabilities {
	let position = false;
	let clicks = false;
	let shapes = false;
	for (const sample of samples) {
		if (
			!position &&
			Number.isFinite(sample.timeMs) &&
			sample.timeMs >= 0 &&
			Number.isFinite(sample.cx) &&
			Number.isFinite(sample.cy) &&
			sample.cx >= 0 &&
			sample.cx <= 1 &&
			sample.cy >= 0 &&
			sample.cy <= 1
		) {
			position = true;
		}
		if (!clicks && sample.interactionType && CLICK_INTERACTIONS.has(sample.interactionType)) {
			clicks = true;
		}
		if (!shapes && typeof sample.cursorType === "string" && sample.cursorType.length > 0) {
			shapes = true;
		}
		if (position && clicks && shapes) break;
	}
	return { position, clicks, shapes };
}

/** The states on screen from `startMs` to `endMs`: the one in force at the start, then every
 *  change up to the end. */ export function cursorStatesBetween(
	changes: readonly CursorStateChange[],
	startMs: number,
	endMs: number,
): Set<string> {
	const states = new Set<string>();
	let atStart = "arrow";
	for (const { timeMs, type } of changes) {
		if (timeMs > endMs) break;
		if (timeMs <= startMs) atStart = type;
		else states.add(type);
	}
	return states.add(atStart);
}

// A recording's cursor file does not change once written: each is read once per session. A
// recording without one reads as empty, and that answer is kept.
const changesByPath = new Map<string, Promise<CursorStateChange[]>>();
// What each of those answered once it did: what the recording's sidecar can actually drive. Kept
// beside the promises so a hook mounted again renders the answer at once, not a frame later.
const capabilitiesByPath = new Map<string, CursorDataCapabilities>();

function stateChangesOf(videoPath: string): Promise<CursorStateChange[]> {
	let changes = changesByPath.get(videoPath);
	if (!changes) {
		changes = Promise.resolve()
			.then(() => nativeBridgeClient.cursor.getRecordingData(videoPath))
			.then((data) => {
				const read = cursorStateChanges(data.samples);
				capabilitiesByPath.set(videoPath, cursorCapabilitiesOf(data.samples));
				return read;
			})
			// A read that failed (no bridge yet, a file still being written) shows nothing but the
			// arrow for now, and is tried again the next time rather than never.
			.catch(() => {
				changesByPath.delete(videoPath);
				return [];
			});
		changesByPath.set(videoPath, changes);
	}
	return changes;
}

/** Each clip as its recording and the stretch of it the timeline plays, in ms. */
function clipSourceRanges(document: AxcutDocument | null): Array<[string, number, number]> {
	if (!document) return [];
	return document.timeline.clips.flatMap((clip) => {
		const asset = document.assets.find((a) => a.id === clip.assetId);
		if (!asset || asset.kind !== "video") return [];
		const range: [string, number, number] = [
			asset.originalPath,
			clip.sourceStartSec * 1000,
			resolveClipSourceEndSec(clip, asset) * 1000,
		];
		return [range];
	});
}

/** Whether one recording's sidecar can drive the pane: a placeable pointer, or a named shape. */
function drawableAt(videoPath: string): boolean | undefined {
	const capabilities = capabilitiesByPath.get(videoPath);
	if (!capabilities) return undefined;
	return capabilities.position || capabilities.shapes;
}

/**
 * Whether one of `paths` has anything the cursor settings can act on: `null` while some are still
 * unread and none has any.
 *
 * `position` is the bar, not `shapes`: a sidecar with usable points and no named cursor type still
 * moves the pointer, so every setting that paints at that point — ripple, trail, halo, size —
 * works. Only the shape pickers need names, and they read `capabilitiesByPath` directly.
 */
function cursorDataIn(paths: readonly string[]): boolean | null {
	if (paths.some((path) => drawableAt(path) === true)) return true;
	return paths.every((path) => drawableAt(path) !== undefined) ? false : null;
}

/**
 * Whether any recording the timeline plays has cursor data, or `null` while they are read. A take
 * recorded with the system cursor has it baked into the pixels and no cursor file, so every cursor
 * setting would change nothing: the editor leaves them out.
 */
export function useHasRecordedCursor(): boolean | null {
	// A string, so the recordings are read again when one is swapped, not on every other edit.
	const pathsJson = useProjectStore((s) =>
		JSON.stringify([...new Set(clipSourceRanges(s.document).map(([path]) => path))]),
	);
	const paths = useMemo(() => JSON.parse(pathsJson) as string[], [pathsJson]);
	// The answer is read off the cache on every render, so it always belongs to the current
	// recordings; each read finishing only asks for another render.
	const [, refresh] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		let cancelled = false;
		for (const path of paths) {
			void stateChangesOf(path).then(() => {
				if (!cancelled) refresh();
			});
		}
		return () => {
			cancelled = true;
		};
	}, [paths]);
	return cursorDataIn(paths);
}

/**
 * Every cursor state the timeline's clips put on screen, or `null` while their recordings are
 * read. The cursor pane offers to redraw these and nothing else: a choice about a cursor the
 * video never shows would change nothing.
 *
 * ponytail: a state seen only inside a cut still counts; subtract the cuts if that ever leaves a
 * choice that changes nothing.
 */
export function useRecordedCursorTypes(): ReadonlySet<string> | null {
	// A string, so the recordings are read again when a clip changes, not on every other edit.
	const rangesJson = useProjectStore((s) => JSON.stringify(clipSourceRanges(s.document)));
	const [types, setTypes] = useState<ReadonlySet<string> | null>(null);
	useEffect(() => {
		let cancelled = false;
		const ranges = JSON.parse(rangesJson) as Array<[string, number, number]>;
		void Promise.all(
			ranges.map(async ([videoPath, startMs, endMs]) =>
				cursorStatesBetween(await stateChangesOf(videoPath), startMs, endMs),
			),
		).then((perClip) => {
			if (!cancelled) setTypes(new Set(perClip.flatMap((states) => [...states])));
		});
		return () => {
			cancelled = true;
		};
	}, [rangesJson]);
	return types;
}
