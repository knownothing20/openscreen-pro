import fs from "node:fs/promises";
import { globalShortcut } from "electron";
import { type ShortcutBinding } from "../src/lib/shortcuts";
import { SHORTCUTS_FILE } from "./ipc/handlers";

const DEFAULT_OPEN_APP_BINDING: ShortcutBinding = { key: "o", ctrl: true, shift: true };

/**
 * The recording marker's chord. `Ctrl+Alt+M` is free: the only M in the app is the
 * editor's BARE `M` (`addAudio`, window-scoped and only while the editor has focus), and
 * nothing anywhere binds Alt — so this cannot shadow an existing shortcut, on any platform.
 *
 * Fixed rather than user-configurable for now. The editor's `shortcuts.json` is the
 * editor's, the HUD has no shortcut settings surface at all, and inventing one to hold a
 * single chord is a screen of UI for a key the user presses mid-recording.
 */
const DEFAULT_RECORDING_MARKER_BINDING: ShortcutBinding = { key: "m", ctrl: true, alt: true };

// Maps KeyboardEvent.key values to Electron accelerator key names
const KEY_TO_ACCELERATOR: Record<string, string> = {
	" ": "Space",
	"+": "Plus",
	"-": "numsub",
	"*": "nummult",
	"/": "numdiv",
	arrowup: "Up",
	arrowdown: "Down",
	arrowleft: "Left",
	arrowright: "Right",
	escape: "Escape",
	enter: "Return",
	backspace: "Backspace",
	delete: "Delete",
	tab: "Tab",
};

function bindingToAccelerator(binding: ShortcutBinding): string {
	const parts: string[] = [];
	if (binding.ctrl) parts.push("CommandOrControl");
	if (binding.shift) parts.push("Shift");
	if (binding.alt) parts.push("Alt");

	const keyLower = binding.key.toLowerCase();
	const acceleratorKey = KEY_TO_ACCELERATOR[keyLower] ?? binding.key.toUpperCase();
	parts.push(acceleratorKey);

	return parts.join("+");
}

// One accelerator per ACTION. This used to be a single slot for the module, which was the
// whole truth while `openApp` was the only global shortcut. The recording marker is the
// second, and the two have different lifetimes — `openApp` lives for the whole run, the
// marker only while a take records — so a shared slot would have meant unregistering one
// to register the other, and the marker's teardown would take the app's shortcut with it.
const registeredAccelerators = new Map<string, string>();

function registerShortcut(
	action: string,
	binding: ShortcutBinding,
	onTrigger: () => void,
): boolean {
	const accelerator = bindingToAccelerator(binding);

	if (accelerator === registeredAccelerators.get(action)) {
		return true;
	}

	// Register the new shortcut before unregistering the old, so a failure leaves the old binding intact
	const success = globalShortcut.register(accelerator, onTrigger);

	if (success) {
		const previous = registeredAccelerators.get(action);
		if (previous) {
			globalShortcut.unregister(previous);
		}
		registeredAccelerators.set(action, accelerator);
		console.log(`Global shortcut registered: ${accelerator} (${action})`);
	} else {
		console.warn(`Failed to register global shortcut: ${accelerator} (${action})`);
	}

	return success;
}

function unregisterShortcut(action: string): void {
	const accelerator = registeredAccelerators.get(action);
	if (!accelerator) return;
	globalShortcut.unregister(accelerator);
	registeredAccelerators.delete(action);
}

export function registerOpenAppShortcut(binding: ShortcutBinding, onTrigger: () => void): boolean {
	return registerShortcut("openApp", binding, onTrigger);
}

/**
 * The recording marker chord, live only while a take runs — see `main.ts`'s
 * `onRecordingStateChange`, which is the one place that knows when that is. A global
 * shortcut held for the whole run would swallow Ctrl+Alt+M in every other application for
 * a control that does not exist outside a recording.
 *
 * The trigger is expected to RELAY the press to the HUD rather than stamp a marker here:
 * the pause-aware elapsed clock lives in the HUD renderer, so main cannot know what second
 * the user meant.
 */
export function registerRecordingMarkerShortcut(onTrigger: () => void): boolean {
	return registerShortcut("recordingMarker", DEFAULT_RECORDING_MARKER_BINDING, onTrigger);
}

export function unregisterRecordingMarkerShortcut(): void {
	unregisterShortcut("recordingMarker");
}

export async function loadAndRegisterGlobalShortcut(onTrigger: () => void): Promise<void> {
	try {
		const data = await fs.readFile(SHORTCUTS_FILE, "utf-8");
		const shortcuts = JSON.parse(data);
		const binding = shortcuts.openApp || DEFAULT_OPEN_APP_BINDING;
		registerOpenAppShortcut(binding, onTrigger);
	} catch {
		registerOpenAppShortcut(DEFAULT_OPEN_APP_BINDING, onTrigger);
	}
}

export function unregisterAllGlobalShortcuts(): void {
	globalShortcut.unregisterAll();
}
