import { app, ipcMain } from "electron";
import { AppSettingsStore, type EncoderPreferences } from "../app-settings";

/**
 * The encoder choice, shared by every window and persisted across restarts.
 *
 * Deliberately thin, and deliberately NOT a per-project setting: which GPU encodes is a property
 * of the machine, not of the timeline. Storing it here is what makes it survive reopening a
 * project — the failure mode this exists to prevent is a user picking the discrete GPU, switching
 * projects, and silently going back to the integrated one.
 */
export function registerEncoderPrefsHandlers(): void {
	const settings = new AppSettingsStore(app.getPath("userData"));
	let prefs: EncoderPreferences = settings.getSnapshot().lastEncoder;

	ipcMain.handle("get-encoder-prefs", () => prefs);
	ipcMain.handle("set-encoder-prefs", (_, next: Partial<EncoderPreferences>) => {
		const device = typeof next?.device === "string" ? next.device : prefs.device;
		// Persist first: a failed write must leave the published value unchanged, so the UI never
		// shows a choice that is not on disk.
		prefs = settings.setEncoderPreferences({ device }).lastEncoder;
		return prefs;
	});
}
