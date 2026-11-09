// Keyboard shortcuts as DISPLAY DATA, never as input.
//
// The sampler reports a virtual-key code plus the modifier state it saw while the
// key went down. That is all it ever reports: no character, no dead-key result, no
// IME output, no clipboard. This module turns that into the short label the
// overlay shows ("Ctrl+S"), and drops anything that could stand for typing:
//
//   - a chord needs Ctrl, Alt or Win. Shift alone is how a capital letter is
//     typed, so Shift+letter is not a shortcut and never reaches the project.
//   - only keys that appear in a shortcut are mapped. OEM punctuation is left
//     out on purpose: Ctrl+. and Ctrl+, are harmless, but the same keys carry
//     typed punctuation, and a whitelist is the only version of this that cannot
//     drift into a keylogger as the code changes.
//
// Everything here is pure so the filter can be tested without a keyboard.

/** The subset of `KBDLLHOOKSTRUCT.vkCode` this feature is willing to name. */
const NAMED_KEYS: Readonly<Record<number, string>> = {
	0x08: "Backspace",
	0x09: "Tab",
	0x0d: "Enter",
	0x1b: "Esc",
	0x20: "Space",
	0x21: "PageUp",
	0x22: "PageDown",
	0x23: "End",
	0x24: "Home",
	0x25: "Left",
	0x26: "Up",
	0x27: "Right",
	0x28: "Down",
	0x2d: "Insert",
	0x2e: "Delete",
};

export interface ShortcutModifiers {
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
	win: boolean;
}

/**
 * The label for a key that may be shown, or null when this key must not be.
 *
 * Null is the answer for everything outside the whitelist — including letters,
 * which are only allowed THROUGH a modifier (see `shortcutCombo`).
 */
export function shortcutKeyLabel(vk: number): string | null {
	if (!Number.isInteger(vk) || vk <= 0) return null;
	if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk); // A–Z
	if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk); // 0–9
	if (vk >= 0x70 && vk <= 0x87) return `F${vk - 0x6f}`; // F1–F24
	return NAMED_KEYS[vk] ?? null;
}

/**
 * "Ctrl+Alt+F9" for a chord that may be shown, or null when it may not.
 *
 * The modifiers are emitted in a fixed order so the same chord always produces
 * the same string — that string is the dedupe key for auto-repeat, and a
 * difference in order would show the same chord twice.
 */
export function shortcutCombo(vk: number, modifiers: ShortcutModifiers): string | null {
	// Shift alone is typing. This single line is the privacy boundary.
	if (!modifiers.ctrl && !modifiers.alt && !modifiers.win) return null;
	const label = shortcutKeyLabel(vk);
	if (!label) return null;
	const parts: string[] = [];
	if (modifiers.ctrl) parts.push("Ctrl");
	if (modifiers.alt) parts.push("Alt");
	if (modifiers.shift) parts.push("Shift");
	if (modifiers.win) parts.push("Win");
	parts.push(label);
	return parts.join("+");
}

/** A repeat of the same chord within this window is the OS auto-repeat, not a second press. */
export const SHORTCUT_REPEAT_WINDOW_MS = 600;

/**
 * Collects filtered shortcuts for one recording.
 *
 * Bounded on purpose: a held chord must not turn into an unbounded array, and a
 * long take with heavy keyboard use must not grow the sidecar without limit.
 * Dropping the OLDEST is the right end to drop — the end of a tutorial is what
 * the viewer is still working on.
 */
export class ShortcutCollector {
	private readonly entries: { timeMs: number; combo: string }[] = [];
	private lastCombo: string | null = null;
	private lastTimeMs = Number.NEGATIVE_INFINITY;
	private dropped = 0;

	constructor(private readonly limit = 2000) {}

	/** Returns true when the event became a shortcut. */
	push(timeMs: number, vk: number, modifiers: ShortcutModifiers): boolean {
		if (!Number.isFinite(timeMs) || timeMs < 0) return false;
		const combo = shortcutCombo(vk, modifiers);
		if (!combo) return false;
		if (
			combo === this.lastCombo &&
			Number.isFinite(this.lastTimeMs) &&
			timeMs - this.lastTimeMs < SHORTCUT_REPEAT_WINDOW_MS
		) {
			return false;
		}
		this.lastCombo = combo;
		this.lastTimeMs = timeMs;
		this.entries.push({ timeMs: Math.round(timeMs), combo });
		if (this.entries.length > this.limit) {
			this.entries.shift();
			this.dropped += 1;
		}
		return true;
	}

	list(): { timeMs: number; combo: string }[] {
		return [...this.entries];
	}

	droppedCount(): number {
		return this.dropped;
	}
}
