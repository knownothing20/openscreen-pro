// The HUD's transient-notice opacity: one definition, because three places need to agree
// on it. Main writes the default into a fresh settings file and clamps what it reads back,
// the HUD paints the notice before any prefs have arrived, and the settings dialog offers
// the levels. Kept out of `app-settings.ts` (which reads the filesystem and is main-only)
// so the renderer can import it, exactly like `recordingSession.ts`.

/** The levels the HUD settings dialog offers, most opaque first. Three discrete steps
 *  rather than a slider: the choice is "how much does this get in my way", which nobody
 *  answers to two decimal places, and each step is a button the dialog already knows how
 *  to draw (the camera-quality row beside it). */
export const MARKER_TOAST_OPACITY_LEVELS = [0.95, 0.72, 0.45] as const;

export const DEFAULT_MARKER_TOAST_OPACITY = 0.72;

/** Above zero on purpose: a notice nobody can read is not a preference, it is a bug. */
export const MIN_MARKER_TOAST_OPACITY = 0.2;

export function clampMarkerToastOpacity(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MARKER_TOAST_OPACITY;
	return Math.min(1, Math.max(MIN_MARKER_TOAST_OPACITY, value));
}

/**
 * How far above the HUD window's bottom edge the marker notice floats.
 *
 * The bar is bottom-anchored — its own margin is `HUD_BAR_BOTTOM` (20px) and it stands
 * ~56px tall — and the window permanently reserves `HUD_MODAL_MAX_HEIGHT` of empty space
 * above it for popovers. 96px clears the bar and lands the notice in space the window was
 * already holding open. Without it, sonner's default bottom-right corner puts the notice
 * ON the control bar, which is the one thing the user is watching while recording.
 */
export const MARKER_TOAST_OFFSET_PX = 96;
