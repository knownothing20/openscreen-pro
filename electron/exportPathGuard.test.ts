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
) => planExportWrite(out, clips, { token: "testtoken" });

describe("planExportWrite — what may be overwritten", () => {
	it("refuses a path that is not absolute", async () => {
		expect(isExportRefusal(await plan("out.mp4"))).toBe(true);
	});

	it("refuses an extension the export never produces", async () => {
		const out = await plan(path.join(dir, "project.openscreen"));
		expect(isExportRefusal(out)).toBe(true);
		if (isExportRefusal(out)) expect(out.reason).toContain(".mp4");
	});

	it("refuses to write over the screen recording being exported", async () => {
		const clip = { screenPath: path.join(dir, "recording.mp4") };
		const out = await plan(path.join(dir, "recording.mp4"), [clip]);
		expect(isExportRefusal(out)).toBe(true);
		if (isExportRefusal(out)) expect(out.reason).toContain("source file");
	});

	it("refuses to write over the webcam source too", async () => {
		const clip = {
			screenPath: path.join(dir, "screen.mp4"),
			webcamPath: path.join(dir, "cam.mp4"),
		};
		expect(isExportRefusal(await plan(path.join(dir, "cam.mp4"), [clip]))).toBe(true);
	});

	it("is not fooled by case, because the filesystem is not", async () => {
		const clip = { screenPath: path.join(dir, "Take.MP4") };
		expect(isExportRefusal(await plan(path.join(dir, "take.mp4"), [clip]))).toBe(true);
	});

	it("allows a new name next to the sources", async () => {
		const clip = { screenPath: path.join(dir, "recording.mp4") };
		const out = await plan(path.join(dir, "export.mp4"), [clip]);
		expect(isExportRefusal(out)).toBe(false);
	});

	it("puts the temp file beside the target, keeping the extension", async () => {
		const out = await plan(path.join(dir, "export.mp4"));
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

		const out = await plan(target);
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

		const out = await plan(target);
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
		const out = await plan(target);
		if (isExportRefusal(out)) throw new Error(out.reason);
		await fs.writeFile(out.tempPath, "DATA");
		await commitExportFile(out);
		expect(await fs.readFile(target, "utf8")).toBe("DATA");
	});
});

describe("path identity on the real filesystem", () => {
	// Every case here is about the SAME file reached by a different spelling. A string compare
	// catches the easy one and misses the rest, and the rest are exactly the ones that destroy a
	// recording: Windows paths are case-insensitive, `C:\a\..\a\b.mp4` is `C:\a\b.mp4`, a symlink
	// is a second name for its target, and a hard link is the same bytes under another name with
	// no path relationship at all.

	it("refuses the same file spelled with different case", async () => {
		const source = path.join(dir, "Take.MP4");
		await fs.writeFile(source, "FOOTAGE");

		const out = await plan(path.join(dir, "take.mp4"), [{ screenPath: source }]);
		expect(isExportRefusal(out)).toBe(true);
	});

	it("refuses a target that is a hard link to a source", async () => {
		const source = path.join(dir, "source.mp4");
		await fs.writeFile(source, "FOOTAGE");
		const linked = path.join(dir, "innocent-name.mp4");
		try {
			await fs.link(source, linked);
		} catch {
			// A filesystem without hard links cannot be asked this question.
			return;
		}

		const out = await plan(linked, [{ screenPath: source }]);
		expect(isExportRefusal(out)).toBe(true);
		if (isExportRefusal(out)) expect(out.reason).toContain("source file");
	});

	it("refuses a target that is a symlink to a source", async () => {
		const source = path.join(dir, "source.mp4");
		await fs.writeFile(source, "FOOTAGE");
		const link = path.join(dir, "looks-unrelated.mp4");
		try {
			await fs.symlink(source, link);
		} catch {
			// Windows refuses file symlinks without developer mode or elevation; the hard-link
			// case above covers the same identity rule on this machine.
			return;
		}

		expect(isExportRefusal(await plan(link, [{ screenPath: source }]))).toBe(true);
	});

	it("refuses a target with .. segments that resolves onto a source", async () => {
		const nested = path.join(dir, "nested");
		await fs.mkdir(nested, { recursive: true });
		const source = path.join(dir, "source.mp4");
		await fs.writeFile(source, "FOOTAGE");

		// `nested/../source.mp4` is `source.mp4`, but the string is different.
		const sneaky = path.join(nested, "..", "source.mp4");
		expect(isExportRefusal(await plan(sneaky, [{ screenPath: source }]))).toBe(true);
	});

	it("refuses a path that cannot be a file because an ancestor is one", async () => {
		const blocker = path.join(dir, "blocker");
		await fs.writeFile(blocker, "not a directory");
		const out = await plan(path.join(blocker, "sub", "out.mp4"), []);
		expect(isExportRefusal(out)).toBe(true);
		if (isExportRefusal(out)) expect(out.reason).toContain("not a directory");
	});

	it("plans a normal export into a directory that does not exist yet", async () => {
		// The handler creates the parent before encoding; refusing here would break a first
		// export into a new folder for no safety gain (there is nothing there to destroy).
		const out = await plan(path.join(dir, "brand", "new", "out.mp4"), []);
		expect(isExportRefusal(out)).toBe(false);
	});

	it("gives every export its own temp name, so two runs cannot collide", async () => {
		const target = path.join(dir, "out.mp4");
		const names = new Set<string>();
		for (let i = 0; i < 50; i++) {
			const out = await planExportWrite(target, []);
			if (isExportRefusal(out)) throw new Error(out.reason);
			names.add(path.basename(out.tempPath));
		}
		expect(names.size).toBe(50);
	});
});

describe("write-back entry (protected paths the clips do not name)", () => {
	// `write-export-to-path` carries no clips: it is the CLI's second pass, which re-reads the
	// export it just made, mixes a voiceover in, and writes the result back. The files it must
	// not eat are the voiceover and the project, and the renderer knows their paths — so they
	// arrive as an explicit list rather than being guessed here.
	it("refuses a target that is one of the extra protected files", async () => {
		// The list is "files this export reads and must not become", not "any file nearby".
		const source = path.join(dir, "capture.mp4");
		await fs.writeFile(source, "FOOTAGE");
		const out = await planExportWrite(source, [], { extraProtected: [source] });
		expect(isExportRefusal(out)).toBe(true);
		if (isExportRefusal(out)) expect(out.reason).toContain("source file");
	});

	it("refuses an extra protected path reached by another spelling", async () => {
		// Same file, different case — the entry that has no clips gets no weaker a check.
		const source = path.join(dir, "CAPTURE.MP4");
		await fs.writeFile(source, "FOOTAGE");
		const out = await planExportWrite(path.join(dir, "capture.mp4"), [], {
			extraProtected: [source],
		});
		expect(isExportRefusal(out)).toBe(true);
	});

	it("still allows the write-back over the file it just read, when that file is the target", async () => {
		// The CLI's mix pass names the export itself as its target. That is a deliberate
		// read-then-replace of a file this process created seconds ago, so it must still plan;
		// the voiceover it also reads is a DIFFERENT file and does not make the target unsafe.
		const target = path.join(dir, "just-exported.mp4");
		await fs.writeFile(target, "VIDEO");
		const voiceover = path.join(dir, "voice.mp4");
		await fs.writeFile(voiceover, "AUDIO");
		const out = await planExportWrite(target, [], { extraProtected: [voiceover] });
		expect(isExportRefusal(out)).toBe(false);
	});
});

describe("discardExportFile — cleanup must never fail the operation", () => {
	it("swallows a path it cannot remove instead of throwing", async () => {
		// A real locked file is hard to stage portably; a directory standing where the file should
		// be produces the same class of error (EPERM/EISDIR) and proves the contract: the caller
		// asked to clean up, and cleanup does not get to fail the export.
		const blocked = path.join(dir, "stuck.mp4");
		await fs.mkdir(blocked);
		await fs.writeFile(path.join(blocked, "keep"), "x");
		await expect(discardExportFile(blocked)).resolves.toBeUndefined();
		// The thing it could not remove is still there — reported, not silently "cleaned".
		expect((await fs.stat(blocked)).isDirectory()).toBe(true);
	});

	it("still removes an ordinary file", async () => {
		const temp = path.join(dir, "ordinary.mp4.partial-x");
		await fs.writeFile(temp, "half written");
		await discardExportFile(temp);
		await expect(fs.stat(temp)).rejects.toThrow();
	});
});
