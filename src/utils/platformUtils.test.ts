// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { canRecordMicrophone, getPlatform, isMac } from "./platformUtils";

// The renderer has no Node `process` global (contextIsolation: true), and
// browser mode has no `electronAPI` at all. jsdom provides `process`, so a
// regression here is invisible to every other gate — this file is the guard.

const original = window.electronAPI;

afterEach(() => {
	window.electronAPI = original;
});

describe("getPlatform", () => {
	it("reads the value the preload exposes", () => {
		window.electronAPI = { getPlatform: () => "darwin" } as typeof window.electronAPI;
		expect(getPlatform()).toBe("darwin");
		expect(isMac()).toBe(true);
	});

	it("falls back to navigator when electronAPI is absent (browser mode)", () => {
		// @ts-expect-error — browser mode genuinely has no electronAPI.
		window.electronAPI = undefined;
		expect(() => getPlatform()).not.toThrow();
		expect(typeof getPlatform()).toBe("string");
	});
});

describe("canRecordMicrophone", () => {
	const pin = (platform: string, systemVersion: string | undefined) => {
		window.electronAPI = {
			getPlatform: () => platform,
			getSystemVersion: () => systemVersion,
		} as unknown as typeof window.electronAPI;
	};

	// ScreenCaptureKit's `captureMicrophone` is macOS 15 API (#700).
	it("is false on macOS 13 and 14", () => {
		for (const version of ["13.0", "13.7.4", "14.0", "14.6.1"]) {
			pin("darwin", version);
			expect(canRecordMicrophone(), version).toBe(false);
		}
	});

	it("is true from macOS 15", () => {
		for (const version of ["15.0", "15.5", "26.5.0"]) {
			pin("darwin", version);
			expect(canRecordMicrophone(), version).toBe(true);
		}
	});

	it("leaves Windows and Linux alone", () => {
		pin("win32", "10.0.26200");
		expect(canRecordMicrophone()).toBe(true);
		pin("linux", "6.8.0-45-generic");
		expect(canRecordMicrophone()).toBe(true);
	});

	it("keeps the microphone when the macOS version is unknown", () => {
		pin("darwin", undefined);
		expect(canRecordMicrophone()).toBe(true);
		pin("darwin", "");
		expect(canRecordMicrophone()).toBe(true);
	});
});
