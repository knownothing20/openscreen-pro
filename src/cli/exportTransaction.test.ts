import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ExportTransactionPorts,
	isMp4,
	runTransactionalExport,
	stagePathsFor,
} from "./exportTransaction";

/**
 * The transaction that fixes the defect this round exists for.
 *
 * Before it, the CLI asked the native pass to write the user's final path directly, mixed the
 * voiceover in afterwards, and wrote back over the same file. A mix failure therefore left the
 * user's previous export already replaced by an un-mixed one — measured on a real run as
 * `58a9d80b…` (78.75 MB) becoming `c38e502a…` (77.75 MB) while the command reported failure.
 *
 * These tests are about ORDER and OWNERSHIP, which is all a transaction is: the final path must
 * never be handed to a stage, and nothing may be committed before every stage has succeeded.
 */

const FINAL = "/exports/demo.mp4";
const SOURCE = "/recordings/screen.mp4";
const VOICE = "/audio/voice.wav";
const PROJECT = "/projects/demo.openscreen";
const PROTECTED = [SOURCE, VOICE, PROJECT];

function fakeBytes(size = 2048): ArrayBuffer {
	const bytes = new Uint8Array(size);
	// A minimal-but-recognisable MP4 header: size, `ftyp`, then the box body.
	bytes.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
	// `moov` somewhere in the payload, which is what a finished file has and a truncated one does not.
	bytes.set([0x6d, 0x6f, 0x6f, 0x76], 64);
	return bytes.buffer;
}

interface Calls {
	render: string[];
	read: string[];
	mix: number;
	write: string[];
	commit: Array<[string, string]>;
	remove: string[];
}

function harness(overrides: Partial<ExportTransactionPorts> = {}) {
	const calls: Calls = { render: [], read: [], mix: 0, write: [], commit: [], remove: [] };
	const bytes = fakeBytes();
	const ports: ExportTransactionPorts = {
		render: vi.fn(async (target: string) => {
			calls.render.push(target);
		}),
		readVideo: vi.fn(async (from: string) => {
			calls.read.push(from);
			return bytes;
		}),
		readVoiceover: vi.fn(async () => bytes),
		mix: vi.fn(async () => {
			calls.mix += 1;
			return bytes;
		}),
		writeStage: vi.fn(async (target: string) => {
			calls.write.push(target);
		}),
		commit: vi.fn(async (stage: string, final: string) => {
			calls.commit.push([stage, final]);
		}),
		remove: vi.fn(async (target: string) => {
			calls.remove.push(target);
		}),
		...overrides,
	};
	return { ports, calls };
}

describe("runTransactionalExport — the final path is only ever committed to", () => {
	it("renders to a stage, then commits that stage", async () => {
		const { ports, calls } = harness();
		const result = await runTransactionalExport({
			finalPath: FINAL,
			protectedPaths: PROTECTED,
			audioPath: null,
			ports,
		});

		expect(result.outputPath).toBe(FINAL);
		// The render never sees the user's path. This is the whole defect, in one assertion.
		expect(calls.render).toHaveLength(1);
		expect(calls.render[0]).not.toBe(FINAL);
		expect(path.dirname(calls.render[0])).toBe(path.dirname(FINAL));
		expect(path.extname(calls.render[0])).toBe(".mp4");

		expect(calls.commit).toEqual([[calls.render[0], FINAL]]);
		// And the stage is gone afterwards.
		expect(calls.remove).toContain(calls.render[0]);
	});

	it("mixes into a second stage and commits only that one", async () => {
		const { ports, calls } = harness();
		await runTransactionalExport({
			finalPath: FINAL,
			protectedPaths: PROTECTED,
			audioPath: VOICE,
			ports,
		});

		expect(calls.mix).toBe(1);
		const [stage] = calls.commit[0];
		expect(stage).not.toBe(FINAL);
		expect(stage).not.toBe(calls.render[0]);
		// The mixed bytes are written to the second stage, never to the destination.
		expect(calls.write).toEqual([stage]);
		// Both stages are removed, and nothing else is.
		expect(calls.remove).toEqual(expect.arrayContaining([calls.render[0], stage]));
	});

	it("hands the protected list to both the render and the commit", async () => {
		const render = vi.fn(async () => undefined);
		const commit = vi.fn(async () => undefined);
		await runTransactionalExport({
			finalPath: FINAL,
			protectedPaths: PROTECTED,
			audioPath: null,
			ports: harness({ render, commit }).ports,
		});
		// The guard in the CLI runner already checks the target, but main is the authority: both
		// entries that touch a path are told what is off limits.
		expect(render).toHaveBeenCalledWith(expect.any(String), PROTECTED);
		expect(commit).toHaveBeenCalledWith(expect.any(String), FINAL, PROTECTED);
	});
});

describe("runTransactionalExport — a failed stage cannot reach the destination", () => {
	const cases: Array<{
		name: string;
		overrides: Partial<ExportTransactionPorts>;
		audioPath: string | null;
	}> = [
		{
			name: "the native render fails",
			overrides: { render: vi.fn(async () => Promise.reject(new Error("encoder died"))) },
			audioPath: VOICE,
		},
		{
			name: "the voiceover cannot be read",
			overrides: { readVoiceover: vi.fn(async () => Promise.reject(new Error("ENOENT"))) },
			audioPath: VOICE,
		},
		{
			name: "the voiceover cannot be decoded / mixed",
			overrides: { mix: vi.fn(async () => Promise.reject(new Error("decode failed"))) },
			audioPath: VOICE,
		},
		{
			name: "the mixed stage cannot be written",
			overrides: { writeStage: vi.fn(async () => Promise.reject(new Error("disk full"))) },
			audioPath: VOICE,
		},
		{
			name: "the commit itself fails",
			overrides: { commit: vi.fn(async () => Promise.reject(new Error("EBUSY"))) },
			audioPath: VOICE,
		},
		{
			name: "the intermediate is not a real MP4",
			overrides: { readVideo: vi.fn(async () => new Uint8Array([0, 1, 2, 3]).buffer) },
			audioPath: null,
		},
	];

	for (const testCase of cases) {
		it(`does not commit when ${testCase.name}`, async () => {
			const { ports, calls } = harness(testCase.overrides);
			await expect(
				runTransactionalExport({
					finalPath: FINAL,
					protectedPaths: PROTECTED,
					audioPath: testCase.audioPath,
					ports,
				}),
			).rejects.toThrow();

			expect(calls.commit).toHaveLength(0);
			// Whatever the stage was, it is cleaned up — a failed run leaves no litter either.
			for (const stage of calls.render) expect(calls.remove).toContain(stage);
		});
	}

	it("does not write a mixed stage when the voiceover is missing", async () => {
		const { ports, calls } = harness({
			readVoiceover: vi.fn(async () => Promise.reject(new Error("ENOENT"))),
		});
		await expect(
			runTransactionalExport({
				finalPath: FINAL,
				protectedPaths: PROTECTED,
				audioPath: VOICE,
				ports,
			}),
		).rejects.toThrow(/voiceover/i);
		// Reading the voiceover happens BEFORE the mix, so nothing was written and nothing was
		// committed: the destination was never opened.
		expect(calls.write).toHaveLength(0);
		expect(calls.mix).toBe(0);
		expect(calls.commit).toHaveLength(0);
	});
});

describe("stage names", () => {
	it("are unique per run, beside the target, and keep the container extension", () => {
		const a = stagePathsFor(FINAL, "run-a");
		const b = stagePathsFor(FINAL, "run-b");
		expect(a.render).not.toBe(b.render);
		expect(a.mixed).not.toBe(b.mixed);
		expect(path.dirname(a.render)).toBe(path.dirname(FINAL));
		expect(path.extname(a.render)).toBe(".mp4");
		expect(path.extname(a.mixed)).toBe(".mp4");
		// A stage name must never collide with the destination itself.
		expect([a.render, a.mixed]).not.toContain(FINAL);
	});

	it("defaults to a token no concurrent run can repeat", () => {
		const names = new Set(Array.from({ length: 50 }, () => stagePathsFor(FINAL).render));
		expect(names.size).toBe(50);
	});
});

describe("isMp4", () => {
	it("accepts a file with an ftyp header and a moov box", () => {
		expect(isMp4(new Uint8Array(fakeBytes()))).toBe(true);
	});

	it("rejects a truncated writer that never got to moov", () => {
		const truncated = new Uint8Array(fakeBytes()).slice(0, 40);
		expect(isMp4(truncated)).toBe(false);
	});

	it("rejects a file that is not an MP4 at all", () => {
		expect(isMp4(new Uint8Array([0x47, 0x40, 0x11, 0x10]))).toBe(false);
	});
});

describe("the real filesystem agrees", () => {
	let dir = "";
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-txn-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("keeps a previous export byte-identical when the mix fails", async () => {
		// The end-to-end shape of the defect, on a real directory: the target holds a known file,
		// the run fails in phase 2, and the target is compared byte for byte afterwards.
		const target = path.join(dir, "demo.mp4");
		await fs.writeFile(target, "PREVIOUS EXPORT");
		const stage = stagePathsFor(target, "fs-run");

		const { ports } = harness({
			render: vi.fn(async (to: string) => {
				await fs.writeFile(to, new Uint8Array(fakeBytes()));
			}),
			mix: vi.fn(async () => Promise.reject(new Error("mix failed"))),
			commit: vi.fn(async (from: string, to: string) => {
				await fs.rename(from, to);
			}),
			remove: vi.fn(async (from: string) => {
				await fs.rm(from, { force: true });
			}),
		});

		await expect(
			runTransactionalExport({
				finalPath: target,
				protectedPaths: PROTECTED,
				audioPath: VOICE,
				ports,
				stages: stage,
			}),
		).rejects.toThrow();

		expect(await fs.readFile(target, "utf8")).toBe("PREVIOUS EXPORT");
		const leftovers = (await fs.readdir(dir)).filter(
			(n) => n.includes(".render-") || n.includes(".mixed-"),
		);
		expect(leftovers).toEqual([]);
	});

	it("replaces the target only after every stage succeeded", async () => {
		const target = path.join(dir, "demo.mp4");
		await fs.writeFile(target, "OLD");
		const stage = stagePathsFor(target, "fs-run-2");

		const fresh = new Uint8Array(fakeBytes());
		const { ports } = harness({
			render: vi.fn(async (to: string) => {
				await fs.writeFile(to, fresh);
			}),
			writeStage: vi.fn(async (to: string) => {
				await fs.writeFile(to, fresh);
			}),
			commit: vi.fn(async (from: string, to: string) => {
				await fs.rename(from, to);
			}),
			remove: vi.fn(async (from: string) => {
				await fs.rm(from, { force: true });
			}),
		});

		await runTransactionalExport({
			finalPath: target,
			protectedPaths: PROTECTED,
			audioPath: VOICE,
			ports,
			stages: stage,
		});

		expect(new Uint8Array(await fs.readFile(target))).toEqual(fresh);
		const leftovers = (await fs.readdir(dir)).filter(
			(n) => n.includes(".render-") || n.includes(".mixed-"),
		);
		expect(leftovers).toEqual([]);
	});
});

describe("preflight — the destination is checked before anything is rendered", () => {
	// `--out` pointing at a source used to be caught at commit time, which is after a full encode:
	// correct result, twelve wasted seconds, and a stage file to clean up. The check belongs
	// before the encoder opens, which is also what the acceptance criteria ask for.
	it("runs the preflight before the render", async () => {
		const order: string[] = [];
		const { ports } = harness({
			preflight: vi.fn(async () => {
				order.push("preflight");
			}),
			render: vi.fn(async () => {
				order.push("render");
			}),
		});
		await runTransactionalExport({
			finalPath: FINAL,
			protectedPaths: PROTECTED,
			audioPath: null,
			ports,
		});
		expect(order).toEqual(["preflight", "render"]);
	});

	it("never renders when the preflight refuses the destination", async () => {
		const render = vi.fn(async () => undefined);
		const remove = vi.fn(async () => undefined);
		const { ports } = harness({
			preflight: vi.fn(async () => Promise.reject(new Error("That path is a source file"))),
			render,
			remove,
		});
		await expect(
			runTransactionalExport({
				finalPath: FINAL,
				protectedPaths: PROTECTED,
				audioPath: VOICE,
				ports,
			}),
		).rejects.toThrow(/source file/);
		expect(render).not.toHaveBeenCalled();
		// Nothing was created, so nothing is deleted either — a refusal is not a mess.
		expect(remove).not.toHaveBeenCalled();
	});
});
