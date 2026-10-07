/**
 * Gets the current platform.
 *
 * The renderer runs with `contextIsolation: true` / `nodeIntegration: false`,
 * so the Node `process` global does not exist here — it lives only in the
 * preload's isolated world. `electron/preload.ts` snapshots `process.platform`
 * once and exposes it as a plain string, which is what we read.
 *
 * Browser mode (`src/native/browserShim.ts`, `?browser`) has no `electronAPI`,
 * so fall back to sniffing `navigator` rather than throwing.
 */
export function getPlatform(): NodeJS.Platform {
	const fromPreload = window.electronAPI?.getPlatform?.();
	if (fromPreload) return fromPreload as NodeJS.Platform;

	if (typeof navigator !== "undefined") {
		const ua = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
		if (/Mac|iPhone|iPad|iPod/.test(ua)) return "darwin";
		if (/Linux|Android/.test(ua)) return "linux";
	}
	return "win32";
}

/**
 * Detects if the current platform is macOS.
 */
export const isMac = (): boolean => getPlatform() === "darwin";

/**
 * Whether a take can record the microphone on this machine.
 *
 * Every macOS take goes through the ScreenCaptureKit helper, which records the
 * microphone with `captureMicrophone`: macOS 15 API. On 13 and 14 the take came
 * out without the voice and without a word (#700), so the microphone is not
 * offered there. A version that does not parse keeps it: the helper still says
 * when it records without the microphone.
 */
export function canRecordMicrophone(): boolean {
	if (getPlatform() !== "darwin") return true;
	const major = Number.parseInt(window.electronAPI?.getSystemVersion?.() ?? "", 10);
	return Number.isNaN(major) || major >= 15;
}
