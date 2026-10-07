/** The slice of `window.electronAPI` the check below needs. */
type NativeCaptureProbe = {
	isNativeMacCaptureAvailable?: () => Promise<{ success: boolean; available: boolean }>;
	isNativeLinuxCaptureAvailable?: () => Promise<{ success: boolean; available: boolean }>;
};

/**
 * Whether choosing the editable cursor changes anything on this machine.
 *
 * Every platform with a native capture helper can leave the system cursor out of the pixels and
 * describe it separately (`captureCursor` on Windows, `hideSystemCursor` on macOS, the portal's
 * METADATA mode on Linux). Without its helper, macOS or Linux records through the browser, which
 * always draws the system cursor into the video (`effectiveBrowserCursorMode`): switching then
 * restores nothing, and an option that changes nothing is not shown. Windows has no such
 * fallback and no probe. A probe that fails counts as no helper.
 *
 * The one answer for every surface that offers the choice (the HUD, and the editor's Record
 * mode), so they cannot disagree about when it exists.
 */
export async function offersEditableCursor(
	platform: string,
	api: NativeCaptureProbe | undefined,
): Promise<boolean> {
	const offersCursorMode = platform === "win32" || platform === "darwin" || platform === "linux";
	const probe =
		platform === "darwin"
			? api?.isNativeMacCaptureAvailable
			: platform === "linux"
				? api?.isNativeLinuxCaptureAvailable
				: undefined;
	if (!probe) return offersCursorMode;
	try {
		const result = await probe();
		return result.success && result.available;
	} catch {
		return false;
	}
}
