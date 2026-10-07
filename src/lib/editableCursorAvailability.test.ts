import { describe, expect, it, vi } from "vitest";
import { offersEditableCursor } from "./editableCursorAvailability";

const answer = (available: boolean, success = true) => vi.fn(async () => ({ success, available }));

describe("offersEditableCursor", () => {
	// Windows has no browser fallback, so there is nothing to probe.
	it("offers it on Windows without asking a helper", async () => {
		expect(await offersEditableCursor("win32", {})).toBe(true);
		expect(await offersEditableCursor("win32", undefined)).toBe(true);
	});

	it("offers it on macOS and Linux only when the native helper answers yes", async () => {
		expect(
			await offersEditableCursor("darwin", { isNativeMacCaptureAvailable: answer(true) }),
		).toBe(true);
		expect(
			await offersEditableCursor("linux", { isNativeLinuxCaptureAvailable: answer(true) }),
		).toBe(true);
	});

	// Without the helper the browser records, and it always draws the system cursor into the
	// video: switching to the editable cursor restores nothing, so it is not offered.
	it("hides it when the helper is missing, or its answer is no", async () => {
		expect(
			await offersEditableCursor("darwin", { isNativeMacCaptureAvailable: answer(false) }),
		).toBe(false);
		expect(
			await offersEditableCursor("linux", { isNativeLinuxCaptureAvailable: answer(true, false) }),
		).toBe(false);
	});

	it("hides it when the probe itself fails", async () => {
		const failing = vi.fn(async () => {
			throw new Error("ipc down");
		});
		expect(await offersEditableCursor("darwin", { isNativeMacCaptureAvailable: failing })).toBe(
			false,
		);
	});

	it("asks the probe of its own platform", async () => {
		const mac = answer(true);
		const linux = answer(false);
		const api = { isNativeMacCaptureAvailable: mac, isNativeLinuxCaptureAvailable: linux };
		expect(await offersEditableCursor("darwin", api)).toBe(true);
		expect(await offersEditableCursor("linux", api)).toBe(false);
		expect(mac).toHaveBeenCalledTimes(1);
		expect(linux).toHaveBeenCalledTimes(1);
	});

	// A build with no preload (the browser shim) has no probe: the platform decides.
	it("falls back to the platform when there is no probe to ask", async () => {
		expect(await offersEditableCursor("darwin", undefined)).toBe(true);
		expect(await offersEditableCursor("linux", {})).toBe(true);
		expect(await offersEditableCursor("freebsd", {})).toBe(false);
	});
});
