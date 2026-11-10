// @vitest-environment jsdom
// The cursor fixture lives in localStorage, so this needs a DOM.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installBrowserShims } from "./browserShim";
import { nativeBridgeClient as realClient } from "./client";

const VIDEO = "C:\\fixtures\\take.mp4";

function fixture(samples: Array<{ timeMs: number; cx: number; cy: number }>) {
	return {
		version: 3,
		provider: "native" as const,
		assets: [],
		samples: samples.map((s) => ({
			...s,
			visible: true,
			interactionType: "move" as const,
		})),
	};
}

describe("browser shim cursor domain", () => {
	beforeAll(() => {
		// The shim only arms itself on a browser-mode URL (`?browser` or `?windowType=editor`),
		// and a plain jsdom document has neither.
		window.history.replaceState({}, "", "/?browser=1");
		delete (window as unknown as { electronAPI?: unknown }).electronAPI;
		installBrowserShims();
	});

	beforeEach(() => {
		localStorage.removeItem("browser-shim-cursor-v1");
	});

	it("reports no recording when no fixture is armed", async () => {
		// The pane hides itself on this answer, which is the behaviour of a take recorded with the
		// system cursor baked into the pixels.
		await expect(realClient.cursor.getRecordingData(VIDEO)).resolves.toBeNull();
		await expect(realClient.cursor.getTelemetry(VIDEO)).resolves.toEqual([]);
	});

	it("returns the fixture for its own path, and the default for anything else", async () => {
		const data = fixture([
			{ timeMs: 0, cx: 0.2, cy: 0.3 },
			{ timeMs: 100, cx: 0.2, cy: 0.3 },
		]);
		localStorage.setItem(
			"browser-shim-cursor-v1",
			JSON.stringify({ [VIDEO]: data, default: fixture([{ timeMs: 0, cx: 0.9, cy: 0.9 }]) }),
		);

		await expect(realClient.cursor.getRecordingData(VIDEO)).resolves.toEqual(data);
		// A different path falls back to `default`, so a spec can arm one fixture for any clip.
		await expect(realClient.cursor.getRecordingData("C:\\other\\clip.mp4")).resolves.toMatchObject({
			version: 3,
		});
		// Telemetry is only the samples — the shape the timeline reads.
		await expect(realClient.cursor.getTelemetry(VIDEO)).resolves.toHaveLength(2);
	});

	it("treats a corrupt fixture as no recording instead of throwing", async () => {
		// A broken sidecar must not take the editor down with it.
		localStorage.setItem("browser-shim-cursor-v1", "{not json");
		await expect(realClient.cursor.getRecordingData(VIDEO)).resolves.toBeNull();
		await expect(realClient.cursor.getCapabilities()).resolves.toMatchObject({
			provider: "native",
		});
	});
});
