import { powerSaveBlocker } from "electron";

let blockerId: number | null = null;

/**
 * Keeps the display awake for the whole take, pauses included (#935). Driven by the
 * same recording flag as the tray, which every backend's start and every stop,
 * cancel and failure path already report, so it is idempotent in both directions:
 * a repeated `true` never stacks a second blocker, a stray `false` is a no-op.
 */
export function setDisplaySleepBlocked(recording: boolean) {
	if (recording && blockerId === null) {
		blockerId = powerSaveBlocker.start("prevent-display-sleep");
	} else if (!recording && blockerId !== null) {
		powerSaveBlocker.stop(blockerId);
		blockerId = null;
	}
}
