import { type FileHandle, open } from "node:fs/promises";

/**
 * Structural check on a finished MP4, done with a file handle instead of the file's bytes.
 *
 * The CLI used to validate a rendered stage by `fetch`ing it into the renderer and calling
 * `isMp4(arrayBuffer)` — which meant a 30-minute export was pulled through Blob *and* copied into
 * an ArrayBuffer before the check could say "yes, that is an MP4". The check only ever needed a
 * few hundred bytes of box headers.
 *
 * So this walks the box tree: read 8 bytes, learn how long the box is, seek past it. `mdat` is
 * where the video lives (hundreds of MB), and it is skipped by arithmetic, never read.
 *
 * What it answers is the same question the old byte scan answered, only correctly: is there an
 * `ftyp` where one belongs, and is there a `moov`? The old scan looked for the four letters `moov`
 * in the first and last megabyte, which both missed a valid file whose moov sits elsewhere and
 * accepted a truncated one that happened to contain the letters.
 */
export interface Mp4Box {
	type: string;
	offset: number;
	/** Declared size, including the header. */
	size: number;
	/** The 32-bit size field was 1 and a 64-bit largesize followed. */
	extended: boolean;
}

export interface Mp4Inspection {
	ok: boolean;
	/** Why not, when `ok` is false. */
	reason?: string;
	fileSize: number;
	hasFtyp: boolean;
	hasMoov: boolean;
	/** Total bytes actually read from disk: box headers only. */
	bytesRead: number;
	/** Boxes seen, in file order. Capped, so a corrupt file cannot grow this without bound. */
	boxes: Mp4Box[];
	/** A box claimed more bytes than the file has. */
	truncated: boolean;
}

/** Enough for any real file (a few dozen boxes) and small enough to stop a loop on corruption. */
const MAX_BOXES = 4096;

/** Reads exactly `length` bytes at `position`; returns null at a short read (end of file). */
async function readAt(
	handle: FileHandle,
	position: number,
	length: number,
	bytesRead: { total: number },
): Promise<Buffer | null> {
	const buffer = Buffer.allocUnsafe(length);
	const { bytesRead: got } = await handle.read(buffer, 0, length, position);
	bytesRead.total += got;
	if (got < length) return null;
	return buffer;
}

export async function inspectMp4(filePath: string): Promise<Mp4Inspection> {
	const result: Mp4Inspection = {
		ok: false,
		fileSize: 0,
		hasFtyp: false,
		hasMoov: false,
		bytesRead: 0,
		boxes: [],
		truncated: false,
	};

	let handle: FileHandle | null = null;
	try {
		handle = await open(filePath, "r");
	} catch (error) {
		result.reason = `cannot open: ${error instanceof Error ? error.message : String(error)}`;
		return result;
	}

	const counter = { total: 0 };
	try {
		const stat = await handle.stat();
		result.fileSize = stat.size;
		if (result.fileSize < 8) {
			result.reason = `file is ${result.fileSize} bytes, too short for a box header`;
			return result;
		}

		let offset = 0;
		let first = true;
		while (offset < result.fileSize) {
			if (result.boxes.length >= MAX_BOXES) {
				result.reason = `more than ${MAX_BOXES} boxes; treating it as corrupt`;
				return result;
			}
			const header = await readAt(handle, offset, 8, counter);
			if (!header) {
				result.truncated = true;
				result.reason = `truncated box header at offset ${offset}`;
				return result;
			}

			const size32 = header.readUInt32BE(0);
			const type = header.toString("latin1", 4, 8);
			let headerLength = 8;
			let size: number;

			if (size32 === 1) {
				// 64-bit largesize follows the type; the header is 16 bytes, not 8.
				const extendedHeader = await readAt(handle, offset + 8, 8, counter);
				if (!extendedHeader) {
					result.truncated = true;
					result.reason = `truncated extended size at offset ${offset}`;
					return result;
				}
				headerLength = 16;
				const large = extendedHeader.readBigUInt64BE(0);
				if (large === 0n) {
					// The spec's "runs to end of file" form.
					size = result.fileSize - offset;
				} else if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
					result.reason = `box at ${offset} claims ${large} bytes`;
					return result;
				} else {
					size = Number(large);
				}
			} else if (size32 === 0) {
				// "To end of file" — legal, and only meaningful for the last box.
				size = result.fileSize - offset;
			} else {
				size = size32;
			}

			if (size < headerLength) {
				result.reason = `box "${type}" at ${offset} declares ${size} bytes, smaller than its own header`;
				return result;
			}
			if (offset + size > result.fileSize) {
				result.truncated = true;
				result.reason = `box "${type}" at ${offset} runs ${offset + size - result.fileSize} bytes past the end of the file`;
				return result;
			}

			result.boxes.push({ type, offset, size, extended: headerLength === 16 });
			if (first) {
				// The old check required `ftyp` as the first box; keep that contract rather than
				// quietly widening what counts as a usable export.
				result.hasFtyp = type === "ftyp";
				first = false;
			}
			if (type === "moov") result.hasMoov = true;

			// `mdat` is the video payload: skip it by arithmetic. Every other box is also skipped
			// this way; nothing but headers is ever read.
			// Every box is skipped this way — including mdat, which is the whole point: its
			// hundreds of megabytes are stepped over by arithmetic, never read.
			offset += size;
		}

		if (!result.hasFtyp) {
			result.reason = "the first box is not ftyp";
			return result;
		}
		if (!result.hasMoov) {
			result.reason = "no moov box — the file has no index";
			return result;
		}
		result.ok = true;
		return result;
	} catch (error) {
		result.reason = `cannot read: ${error instanceof Error ? error.message : String(error)}`;
		return result;
	} finally {
		result.bytesRead = counter.total;
		// Always closed, including every early return above.
		await handle.close().catch(() => undefined);
	}
}
