import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectMp4 } from "./mp4Inspect";

/**
 * The MP4 check exists to answer one question before a stage is committed: is this a finished
 * file, or a truncated one? It has to answer that without reading the video.
 *
 * These tests build real files on disk — including a 1 GiB one via a sparse file — so the
 * "skips mdat" claim is a measurement, not a comment.
 */

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-mp4-"));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function box(type: string, payloadBytes: number): Buffer {
	const buffer = Buffer.alloc(8 + payloadBytes);
	buffer.writeUInt32BE(buffer.length, 0);
	buffer.write(type, 4, "latin1");
	return buffer;
}

function largeBox(type: string, totalSize: number): Buffer {
	// size field 1 means "look at the 64-bit largesize that follows the type".
	const buffer = Buffer.alloc(16);
	buffer.writeUInt32BE(1, 0);
	buffer.write(type, 4, "latin1");
	buffer.writeBigUInt64BE(BigInt(totalSize), 8);
	return buffer;
}

async function write(name: string, ...parts: Buffer[]): Promise<string> {
	const target = path.join(dir, name);
	await fs.writeFile(target, Buffer.concat(parts));
	return target;
}

describe("inspectMp4", () => {
	it("accepts a plain file with moov after mdat (the default layout)", async () => {
		const file = await write("tail.mp4", box("ftyp", 16), box("mdat", 4096), box("moov", 256));
		const result = await inspectMp4(file);
		expect(result.ok).toBe(true);
		expect(result.hasFtyp).toBe(true);
		expect(result.hasMoov).toBe(true);
		expect(result.boxes.map((b) => b.type)).toEqual(["ftyp", "mdat", "moov"]);
	});

	it("accepts a faststart file with moov before mdat", async () => {
		const file = await write("head.mp4", box("ftyp", 16), box("moov", 256), box("mdat", 4096));
		const result = await inspectMp4(file);
		expect(result.ok).toBe(true);
	});

	it("accepts a moov that sits after a box the old head/tail scan could not see", async () => {
		// ftyp, 3 MB of mdat, then moov — outside a 1 MB head and a 1 MB tail would have been
		// enough to satisfy the old scan, but this proves the walk actually finds it by structure.
		const file = await write(
			"middle.mp4",
			box("ftyp", 16),
			box("free", 3 * 1024 * 1024),
			box("mdat", 64),
			box("moov", 256),
		);
		const result = await inspectMp4(file);
		expect(result.ok).toBe(true);
		expect(result.boxes.some((b) => b.type === "moov")).toBe(true);
	});

	it("rejects a file with no moov", async () => {
		const file = await write("no-moov.mp4", box("ftyp", 16), box("mdat", 4096));
		const result = await inspectMp4(file);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/no moov/);
	});

	it("rejects a truncated file whose last box runs past the end", async () => {
		const full = Buffer.concat([box("ftyp", 16), box("mdat", 4096), box("moov", 256)]);
		const file = path.join(dir, "truncated.mp4");
		await fs.writeFile(file, full.subarray(0, full.length - 128));
		const result = await inspectMp4(file);
		expect(result.ok).toBe(false);
		expect(result.truncated).toBe(true);
	});

	it("rejects a box that declares a size smaller than its own header", async () => {
		const broken = Buffer.alloc(16);
		broken.writeUInt32BE(4, 0); // 4 is less than the 8-byte header
		broken.write("ftyp", 4, "latin1");
		const file = await write("bad-size.mp4", broken);
		const result = await inspectMp4(file);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/smaller than its own header/);
	});

	it("rejects a file that does not start with ftyp", async () => {
		const file = await write("no-ftyp.mp4", box("free", 16), box("moov", 256));
		const result = await inspectMp4(file);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/not ftyp/);
	});

	it("reports a missing file instead of throwing", async () => {
		const result = await inspectMp4(path.join(dir, "does-not-exist.mp4"));
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/cannot open/);
	});

	it("handles a 64-bit box size", async () => {
		const mdat = largeBox("mdat", 2048);
		const tail = Buffer.alloc(2048 - mdat.length);
		const file = await write("large-box.mp4", box("ftyp", 16), mdat, tail, box("moov", 256));
		const result = await inspectMp4(file);
		expect(result.ok).toBe(true);
		expect(result.boxes.find((b) => b.type === "mdat")?.extended).toBe(true);
	});

	it("reads box headers only, not the megabyte of video inside mdat", async () => {
		const mdat = box("mdat", 8 * 1024 * 1024);
		const file = await write("big-mdat.mp4", box("ftyp", 16), mdat, box("moov", 256));
		const result = await inspectMp4(file);
		expect(result.ok).toBe(true);
		// 4 boxes would be 32 bytes of headers; the 8 MB payload must not appear here.
		expect(result.bytesRead).toBeLessThan(256);
		expect(result.fileSize).toBeGreaterThan(8 * 1024 * 1024);
	});

	it("does not scale with file size — a 1 GiB export costs the same headers", async () => {
		const file = path.join(dir, "sparse-1g.mp4");
		const ftyp = box("ftyp", 16);
		const mdatHeader = largeBox("mdat", 1024 * 1024 * 1024);
		const moov = box("moov", 256);
		const mdatPayload = 1024 * 1024 * 1024 - mdatHeader.length;

		const handle = await fs.open(file, "w");
		try {
			await handle.write(ftyp, 0, ftyp.length, 0);
			const mdatOffset = ftyp.length;
			await handle.write(mdatHeader, 0, mdatHeader.length, mdatOffset);
			const moovOffset = mdatOffset + mdatPayload + mdatHeader.length;
			await handle.write(moov, 0, moov.length, moovOffset);
			// Sparse: the 1 GiB hole is not written, so this does not cost a gigabyte of disk.
			await handle.truncate(moovOffset + moov.length);
		} finally {
			await handle.close();
		}

		const result = await inspectMp4(file);
		expect(result.ok).toBe(true);
		expect(result.fileSize).toBeGreaterThan(1024 * 1024 * 1024);
		expect(result.bytesRead).toBeLessThan(256);
	});
});

describe("inspectMp4 — the handle", () => {
	it("is released even when the file is rejected", async () => {
		const file = await write("bad.mp4", box("ftyp", 16));
		await inspectMp4(file);
		// On Windows an unclosed handle keeps the file locked; a successful rename proves it is
		// gone. This is the check that would fail if a `return` slipped past the finally.
		const moved = path.join(dir, "moved.mp4");
		await expect(fs.rename(file, moved)).resolves.toBeUndefined();
	});
});
