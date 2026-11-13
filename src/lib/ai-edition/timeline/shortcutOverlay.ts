/**
 * Which shortcut card, if any, is on screen at a given moment.
 *
 * The recording already carries `shortcuts: [{ timeMs, combo }]` in its cursor sidecar (V2.7.1),
 * and nothing has ever drawn them. This module is the decision half of the overlay: given the
 * events, the user's settings and a time, say what the picture should show. It is a pure function
 * on purpose — the frame a seek lands on must not depend on how it got there, so scrubbing
 * backwards through a card has to give the same answer as scrubbing forwards.
 *
 * Deliberately not a document object: nothing here is written into the project, so a card can
 * never be left behind at a trim boundary or survive a clip reorder as a ghost.
 */

export interface ShortcutOverlaySettings {
	/** Off by default: the overlay is opt-in, like the recording of the chords themselves. */
	enabled: boolean;
	/** How long a card stays up after its chord is pressed. */
	durationMs: number;
	position: "top-center" | "bottom-center" | "bottom-left" | "bottom-right";
	/** Font size as a fraction of the frame height, the same unit `SceneAnnotation` uses. */
	fontSizeRel: number;
	background: string;
	color: string;
	radiusPx: number;
	opacity: number;
}

export const DEFAULT_SHORTCUT_OVERLAY: ShortcutOverlaySettings = {
	enabled: false,
	durationMs: 1500,
	position: "bottom-center",
	fontSizeRel: 0.045,
	background: "#111318",
	color: "#f4f6fb",
	radiusPx: 10,
	opacity: 0.92,
};

/** One chord as the sidecar stores it. */
export interface RecordedShortcut {
	timeMs: number;
	combo: string;
}

/**
 * `Ctrl+Shift+P` yes, `hello world` no.
 *
 * The sidecar is supposed to hold chords only — `normalizeCursorShortcut` drops the keystroke and
 * keeps the label. This is the second gate, at the point of drawing: if something that is not a
 * chord ever reaches the file (an older build, a hand-edited sidecar), it must not be painted over
 * someone's screen. A chord is a few `+`-joined tokens, each short, and at least one of them is a
 * modifier or a function key.
 */
const MODIFIERS = new Set([
	"ctrl",
	"control",
	"shift",
	"alt",
	"option",
	"cmd",
	"command",
	"win",
	"meta",
	"super",
]);
const MAX_TOKENS = 5;
const MAX_TOKEN_LENGTH = 12;

export function looksLikeChord(combo: string): boolean {
	const tokens = combo
		.split("+")
		.map((token) => token.trim())
		.filter(Boolean);
	if (tokens.length === 0 || tokens.length > MAX_TOKENS) return false;
	if (tokens.some((token) => token.length > MAX_TOKEN_LENGTH)) return false;
	const hasModifier = tokens.some((token) => MODIFIERS.has(token.toLowerCase()));
	const hasFunctionKey = tokens.some((token) => /^f([1-9]|1[0-9]|2[0-4])$/i.test(token));
	// A bare "Ctrl" or a lone "a" is not a chord worth showing; require a real key next to the
	// modifier, or a function key on its own.
	return hasFunctionKey || (hasModifier && tokens.length >= 2);
}

export interface ShortcutCard {
	combo: string;
	/** The chord's own timestamp, so a caller can key animation off the press. */
	pressedAtMs: number;
	/** How far into the card's life `atMs` is, 0..1 — drives the enter/exit fade. */
	progress: number;
}

/**
 * The card to draw at `atMs`, or `null`.
 *
 * Windows do not overlap in practice (a chord is followed by another only after a beat), but when
 * they do the LATEST one wins: the picture shows the key the user just pressed, not the one before
 * it. Equal timestamps keep the later entry in the file, which is the order they were recorded in.
 */
export function shortcutCardAt(
	shortcuts: readonly RecordedShortcut[] | null | undefined,
	settings: ShortcutOverlaySettings,
	atMs: number,
): ShortcutCard | null {
	if (!settings.enabled) return null;
	if (!shortcuts || shortcuts.length === 0) return null;
	if (!Number.isFinite(atMs)) return null;
	const duration = Math.max(1, settings.durationMs);

	let best: RecordedShortcut | null = null;
	for (const shortcut of shortcuts) {
		if (!Number.isFinite(shortcut.timeMs)) continue;
		if (!shortcut.combo || !looksLikeChord(shortcut.combo)) continue;
		const elapsed = atMs - shortcut.timeMs;
		if (elapsed < 0 || elapsed >= duration) continue;
		if (!best || shortcut.timeMs >= best.timeMs) best = shortcut;
	}
	if (!best) return null;
	return {
		combo: best.combo,
		pressedAtMs: best.timeMs,
		progress: Math.min(1, Math.max(0, (atMs - best.timeMs) / duration)),
	};
}

/** The minimum a clip has to expose for a card to be placed on it. */
export interface ShortcutCardClip {
	/** The screen recording this clip plays — the same path the sidecar is keyed by. */
	screenPath: string;
	sourceStartSec: number;
	sourceEndSec: number;
}

/** One card, placed on the clip that shows the footage it belongs to. */
export interface ShortcutCardSpan {
	clipIndex: number;
	/** SOURCE seconds, the unit `SceneAnnotation.startSec`/`endSec` are in. */
	startSec: number;
	endSec: number;
	combo: string;
}

/**
 * Place every chord on every clip that plays the footage it happened in.
 *
 * The scene's annotations are addressed in `sourceTime` (see `SceneDescription.annotations`), and
 * a chord's `timeMs` is already source time, so this needs no programme/speed conversion at all:
 * speed changes how long a span stays on screen, not where it sits in the recording, and the
 * timeline's own projection handles the rest.
 *
 * Three properties fall out of addressing clips instead of the timeline:
 *
 * - **Trimmed away → gone.** A chord outside `[sourceStartSec, sourceEndSec)` matches no clip and
 *   is never drawn, so a trim cannot leave a card floating over footage that no longer exists.
 * - **Split → shown twice.** One source chord that lands in two clips produces two spans, which is
 *   correct: both clips really do play that moment.
 * - **Reordered → follows the footage.** The span carries `clipIndex`, so moving a clip moves the
 *   card with it rather than leaving it at the old timeline position.
 *
 * A card never spills past its clip's end: if the chord lands in the last second of a clip, the
 * card is cut there rather than bleeding into the next shot.
 */
import { outputDurationOfRawSpan, type PlaybackSpeedRegion } from "../document/timeline";

/**
 * How much SOURCE time the card has to cover to stay on screen for `outputSec` of programme.
 *
 * Inverting the existing forward mapping rather than dividing by speed: a 2x stretch makes one
 * source second play for half a second, and a span that crosses several speed regions has no
 * single multiplier. Bisection over `outputDurationOfRawSpan` handles all of that with one
 * authority for the arithmetic, and cannot disagree with the rest of the timeline about what a
 * speed region means.
 */
export function sourceSpanSecForOutputSec(
	atSec: number,
	outputSec: number,
	speedRegions: readonly PlaybackSpeedRegion[] = [],
): number {
	if (!(outputSec > 0)) return 0;
	if (speedRegions.length === 0) return outputSec;
	const speeds = speedRegions.map((r) => (r.speed > 0 ? r.speed : 1));
	const fastest = Math.max(1, ...speeds);
	const slowest = Math.min(1, ...speeds);
	let lo = outputSec * slowest;
	let hi = outputSec * fastest;
	// Bracket first: hi must already produce at least `outputSec` of programme.
	for (
		let i = 0;
		i < 8 && outputDurationOfRawSpan(atSec, atSec + hi, [...speedRegions]) < outputSec;
		i++
	) {
		hi *= 2;
	}
	for (let i = 0; i < 60; i++) {
		const mid = (lo + hi) / 2;
		if (outputDurationOfRawSpan(atSec, atSec + mid, [...speedRegions]) < outputSec) lo = mid;
		else hi = mid;
	}
	return hi;
}

export function shortcutCardSpans(
	clips: readonly ShortcutCardClip[],
	events: readonly RecordedShortcut[] | null | undefined,
	settings: ShortcutOverlaySettings,
	/** The recording these events came from. Omit only when every clip plays that same file. */
	videoPath?: string,
	/** Speed regions, so `durationMs` means programme time rather than source time. */
	speedRegions: readonly PlaybackSpeedRegion[] = [],
): ShortcutCardSpan[] {
	if (!settings.enabled) return [];
	if (!events || events.length === 0) return [];
	const durationSec = Math.max(1, settings.durationMs) / 1000;
	const spans: ShortcutCardSpan[] = [];
	for (const event of events) {
		if (!Number.isFinite(event.timeMs) || event.timeMs < 0) continue;
		if (!event.combo || !looksLikeChord(event.combo)) continue;
		const atSec = event.timeMs / 1000;
		// `durationSec` is programme time. Convert once, then spend that much SOURCE time across
		// however many clips show it — a split at second 3 must not cut the card in half.
		const sourceSpanSec = sourceSpanSecForOutputSec(atSec, durationSec, speedRegions);
		const startIndex = clips.findIndex(
			(clip) =>
				(videoPath === undefined || clip.screenPath === videoPath) &&
				atSec >= clip.sourceStartSec &&
				atSec < clip.sourceEndSec,
		);
		if (startIndex < 0) continue;
		let remaining = sourceSpanSec;
		let cursor = atSec;
		for (let index = startIndex; index < clips.length && remaining > 0; index++) {
			const clip = clips[index];
			if (index > startIndex) {
				const previous = clips[index - 1];
				// Only carry on when the next clip keeps playing the same take from where the last
				// one stopped. A reordered or trimmed timeline breaks that, and the card must end
				// rather than appear over unrelated footage.
				if (clip.screenPath !== previous.screenPath) break;
				if (Math.abs(clip.sourceStartSec - previous.sourceEndSec) > 1e-6) break;
				cursor = clip.sourceStartSec;
			}
			const room = clip.sourceEndSec - cursor;
			if (room <= 0) break;
			const take = Math.min(room, remaining);
			spans.push({ clipIndex: index, startSec: cursor, endSec: cursor + take, combo: event.combo });
			remaining -= take;
			cursor = clip.sourceEndSec;
		}
	}
	return spans;
}
