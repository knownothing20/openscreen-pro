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
