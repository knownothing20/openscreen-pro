import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	commitExportFile,
	discardExportFile,
	exportedSourcePaths,
	isExportRefusal,
	planExportWrite,
} from "./exportPathGuard";

/** A directory of our own, so nothing here can touch a real project. */
let dir = "";

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-export-guard-"));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const plan = (
	out: string | undefined,
	clips: Array<{ screenPath?: string; webcamPath?: string }> = [],
) => planExportWrite(out, clips, "testtoken");

describe("planExportWrite — what may be overwritten", () => {
	it("refuses a path that is not absolute", () => {
		const out = plan("out.mp4");
		expect(isExportRefusal(out)).toBe(true);
	});

	it("refuses an extension the export never produces", () => {
		const out = plan(path.join(dir, "project.openscreen"));
		expect(isExportRefusal(out)).toBe(true);
		if (isExportRefusal(out)) expect(out.reason).toContain(".mp4");
	});

	it("refuses to write over the screen recording being exported", () => {
		const clip = { screenPath: path.join(dir, "recording.mp4") };
		const out = plan(path.join(dir, "recording.mp4"), [clip]);
		expect(isExportRefusal(out)).toBe(true);
		if (isExportRefusal(out)) expect(out.reason).toContain("source file");
	});

	it("refuses to write over the webcam source too", () => {
		const clip = {
			screenPath: path.join(dir, "screen.mp4"),
			webcamPath: path.join(dir, "cam.mp4"),
		};
		expect(isExportRefusal(plan(path.join(dir, "cam.mp4"), [clip]))).toBe(true);
	});

	it("is not fooled by case, because the filesystem is not", () => {
		const clip = { screenPath: path.join(dir, "Take.MP4") };
		expect(isExportRefusal(plan(path.join(dir, "take.mp4"), [clip]))).toBe(true);
	});

	it("allows a new name next to the sources", () => {
		const clip = { screenPath: path.join(dir, "recording.mp4") };
		const out = plan(path.join(dir, "export.mp4"), [clip]);
		expect(isExportRefusal(out)).toBe(false);
	});

	it("puts the temp file beside the target, keeping the extension", () => {
		const out = plan(path.join(dir, "export.mp4"));
		if (isExportRefusal(out)) throw new Error(out.reason);
		// Same directory: a rename cannot cross a volume, and the rename IS the commit.
		expect(path.dirname(out.tempPath)).toBe(path.resolve(dir));
		expect(path.extname(out.tempPath)).toBe(".mp4");
		expect(out.tempPath).not.toBe(out.finalPath);
		// Recognisable as ours, so an orphan is obviously litter rather than a video.
		expect(path.basename(out.tempPath)).toContain(".partial-testtoken");
	});
});

describe("exportedSourcePaths", () => {
	it("collects both sources of every clip and skips the empty ones", () => {
		expect(
			exportedSourcePaths([
				{ screenPath: "/a.mp4", webcamPath: "/a-cam.mp4" },
				{ screenPath: "/b.mp4", webcamPath: "" },
				{},
			]),
		).toEqual(["/a.mp4", "/a-cam.mp4", "/b.mp4"]);
	});

	it("survives a payload with no clips", () => {
		expect(exportedSourcePaths(undefined)).toEqual([]);
	});
});

describe("commitExportFile / discardExportFile", () => {
	it("replaces an existing export only once the new one is complete", async () => {
		const target = path.join(dir, "export.mp4");
		await fs.writeFile(target, "OLD");

		const out = plan(target);
		if (isExportRefusal(out)) throw new Error(out.reason);
		await fs.writeFile(out.tempPath, "NEW");

		await commitExportFile(out);
		expect(await fs.readFile(target, "utf8")).toBe("NEW");
		// The temp file is gone: it became the target.
		await expect(fs.stat(out.tempPath)).rejects.toThrow();
	});

	it("leaves the previous export untouched when the write never finishes", async () => {
		const target = path.join(dir, "export.mp4");
		await fs.writeFile(target, "OLD");

		const out = plan(target);
		if (isExportRefusal(out)) throw new Error(out.reason);
		// The encoder died before producing anything; there is a half-written temp at most.
		await fs.writeFile(out.tempPath, "HAL");
		await discardExportFile(out.tempPath);

		expect(await fs.readFile(target, "utf8")).toBe("OLD");
		await expect(fs.stat(out.tempPath)).rejects.toThrow();
	});

	it("treats a missing temp file as already cleaned up", async () => {
		await expect(discardExportFile(path.join(dir, "never-existed.mp4"))).resolves.toBeUndefined();
	});

	it("creates the target when there was nothing there before", async () => {
		const target = path.join(dir, "first-export.mp4");
		const out = plan(target);
		if (isExportRefusal(out)) throw new Error(out.reason);
		await fs.writeFile(out.tempPath, "DATA");
		await commitExportFile(out);
		expect(await fs.readFile(target, "utf8")).toBe("DATA");
	});
});
