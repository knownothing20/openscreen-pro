import type { Rectangle } from "electron";
import type { NativeCursorType } from "../../../../src/native/contracts";

export interface WindowsCursorSampleEvent {
	type: "sample";
	timestampMs: number;
	/**
	 * Milliseconds on the sampler's steady clock, from its own process start.
	 *
	 * Present from the sampler that added it; absent on an older helper, which is
	 * why the session falls back to `timestampMs` (and says so in its diagnostics).
	 */
	monotonicMs?: number;
	x: number;
	y: number;
	visible: boolean;
	handle: string | null;
	cursorType?: NativeCursorType | null;
	leftButtonDown?: boolean;
	leftButtonPressed?: boolean;
	leftButtonReleased?: boolean;
	rightButtonDown?: boolean;
	rightButtonPressed?: boolean;
	rightButtonReleased?: boolean;
	middleButtonDown?: boolean;
	middleButtonPressed?: boolean;
	middleButtonReleased?: boolean;
	/** Raw wheel delta seen since the previous sample (120 per notch, sign = direction). */
	wheelDelta?: number;
	bounds?: {
		x: number;
		y: number;
		width: number;
		height: number;
	} | null;
	asset: WindowsCursorAssetPayload | null;
}

export interface WindowsCursorReadyEvent {
	type: "ready";
	timestampMs: number;
	monotonicMs?: number;
	/** True when the keyboard hook was installed (`--keys`); false/absent otherwise. */
	shortcuts?: boolean;
}

export interface WindowsCursorErrorEvent {
	type: "error";
	timestampMs: number;
	monotonicMs?: number;
	message: string;
}

/** One key chord, as the sampler saw it: virtual-key code plus modifier state.
 * There is deliberately no character field — the sampler has none to send.
 */
export interface WindowsCursorShortcutEvent {
	type: "shortcut";
	timestampMs: number;
	monotonicMs?: number;
	vk: number;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
	win: boolean;
}

export interface WindowsCursorAssetPayload {
	id: string;
	imageDataUrl: string;
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
	cursorType?: NativeCursorType | null;
}

export type WindowsCursorEvent =
	| WindowsCursorSampleEvent
	| WindowsCursorReadyEvent
	| WindowsCursorErrorEvent
	| WindowsCursorShortcutEvent;

export interface WindowsNativeRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	maxSamples: number;
	sampleIntervalMs: number;
	sourceId?: string | null;
	startTimeMs?: number;
	/** Ask the helper for the shortcut channel (`--keys`). Off unless the user opted in. */
	captureShortcuts?: boolean;
}
