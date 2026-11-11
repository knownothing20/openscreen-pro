import { nativeBridgeClient } from "@/native/client";
import type { SceneAnnotation, SceneDescription } from "@/native/sceneDescription";
import type { AxcutDocument } from "../schema";
import { getEditorSettings } from "../store/editorSettings";
import { looksLikeChord, type RecordedShortcut, shortcutCardSpans } from "./shortcutOverlay";

/**
 * The shortcut overlay, applied to a finished scene.
 *
 * `buildSceneDescription` is synchronous and sees only the document; the chords live in the cursor
 * sidecar, which is read over the native bridge. So the overlay cannot be built *inside* the scene
 * builder — it is applied *to* the result, here, and the preview and both export paths call this
 * one function. Three copies of "when does this card show" is exactly how a preview ends up
 * disagreeing with a render.
 *
 * The sidecar of a recording does not change while the app runs, so each path is read once and the
 * promise is kept: scrubbing never re-reads megabytes of JSON per frame, and a failure is not
 * cached — it is retried on the next caller.
 */
const shortcutsByPath = new Map<string, Promise<RecordedShortcut[]>>();

function shortcutsOf(videoPath: string): Promise<RecordedShortcut[]> {
	let pending = shortcutsByPath.get(videoPath);
	if (!pending) {
		pending = Promise.resolve()
			.then(() => nativeBridgeClient.cursor.getRecordingData(videoPath))
			.then((data) => (data?.shortcuts ?? []).filter((event) => looksLikeChord(event.combo)))
			.catch(() => {
				shortcutsByPath.delete(videoPath);
				return [] as RecordedShortcut[];
			});
		shortcutsByPath.set(videoPath, pending);
	}
	return pending;
}

/** Forget a recording's chords — for a replaced take, or a test. */
export function forgetShortcutsFor(videoPath: string): void {
	shortcutsByPath.delete(videoPath);
}

/** Every screen recording the timeline plays, in clip order, deduplicated. */
function screenPathsIn(document: AxcutDocument): string[] {
	const paths = new Set<string>();
	for (const clip of document.timeline.clips) {
		const asset = document.assets.find((a) => a.id === clip.assetId);
		if (asset?.kind === "video" && asset.originalPath) paths.add(asset.originalPath);
	}
	return [...paths];
}

/**
 * Append the cards the settings and sidecars call for. Returns the scene untouched when the
 * overlay is off, when no take has chords, or when every read failed.
 */
export async function withShortcutOverlay(
	scene: SceneDescription,
	document: AxcutDocument,
): Promise<SceneDescription> {
	const settings = getEditorSettings(document).cursor.shortcutOverlay;
	if (!settings.enabled) return scene;
	const paths = screenPathsIn(document);
	if (paths.length === 0) return scene;

	const perPath = await Promise.all(
		paths.map(async (path) => ({ path, events: await shortcutsOf(path) })),
	);
	const cards: SceneAnnotation[] = [];
	for (const { path, events } of perPath) {
		if (events.length === 0) continue;
		for (const span of shortcutCardSpans(scene.clips, events, settings, path)) {
			cards.push(cardAnnotation(span, settings));
		}
	}
	if (cards.length === 0) return scene;
	// Copied, not mutated: the caller may still be holding the scene it passed in.
	return { ...scene, annotations: [...scene.annotations, ...cards] };
}

function cardAnnotation(
	span: { clipIndex: number; startSec: number; endSec: number; combo: string },
	settings: ReturnType<typeof getEditorSettings>["cursor"]["shortcutOverlay"],
): SceneAnnotation {
	const box = cardBox(settings);
	return {
		id: `shortcut-${span.clipIndex}-${Math.round(span.startSec * 1000)}`,
		startSec: span.startSec,
		endSec: span.endSec,
		clipIndex: span.clipIndex,
		kind: "text",
		x: box.x,
		y: box.y,
		w: box.w,
		h: box.h,
		// Above the user's own annotations: the keys are a heads-up layer, not a caption.
		zIndex: 900,
		text: {
			content: span.combo,
			color: settings.color,
			backgroundColor: settings.background,
			fontSizeRel: settings.fontSizeRel,
			fontFamily: "system-ui",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			textAlign: "center",
			verticalAlign: "center",
			// The compositor's own fade is enough for a first pass; the card's whole life is a
			// couple of seconds, so an animation curve here would be more machinery than picture.
			animation: null,
		},
	};
}

/**
 * Where the card sits, as fractions of the frame.
 *
 * The text box has no corner radius, so the card is a rectangle — a recorded limitation rather
 * than a reason to add a compositor pass for a rounded corner.
 */
function cardBox(settings: ReturnType<typeof getEditorSettings>["cursor"]["shortcutOverlay"]): {
	x: number;
	y: number;
	w: number;
	h: number;
} {
	const h = Math.min(0.2, settings.fontSizeRel * 2.8);
	const w = 0.44;
	switch (settings.position) {
		case "top-center":
			return { x: (1 - w) / 2, y: 0.07, w, h };
		case "bottom-left":
			return { x: 0.05, y: 0.93 - h, w, h };
		case "bottom-right":
			return { x: 0.95 - w, y: 0.93 - h, w, h };
		default:
			return { x: (1 - w) / 2, y: 0.93 - h, w, h };
	}
}
