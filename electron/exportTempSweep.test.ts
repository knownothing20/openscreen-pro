import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyExportTempName, sweepStaleExportTemps } from "./exportTempSweep";

/**
 * A sweep that deletes files is only as good as what it refuses to delete.
 *
 * Every case here is a real name this app produces (see `exportPathGuard.ts` and
 * `planExportWrite`), plus the files it must never touch: the user's export, the footage the
 * project reads, and a file another process is still writing.
 *
 * The two cases the 1.2 rule set could not answer are here by name: an old `render-` stage that
 * belongs to another CLI process, and a user's own MP4 that happens to sit behind a matching
 * name. Neither carries a pid, so neither can be attributed to this app — and a name is not
 * ownership. Both must survive, which is why stage names are no longer swept at all.
 */

let dir = "";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function write(name: string, ageMs: number): Promise<string> {
	const file = path.join(dir, name);
	await fs.writeFile(file, "x");
	const when = new Date(Date.now() - ageMs);
	await fs.utimes(file, when, when);
	return file;
}

const names = async (): Promise<string[]> => (await fs.readdir(dir)).sort();

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-export-sweep-"));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("classifyExportTempName — the whitelist", () => {
	it("recognises the two transaction stages", () => {
		expect(classifyExportTempName("demo.render-mw82t9k6-4qhjjaaa.mp4")).toEqual({
			kind: "render-stage",
			pid: null,
		});
		expect(classifyExportTempName("demo.mixed-mw82t9k6-4qhjjaaa.mp4")).toEqual({
			kind: "mixed-stage",
			pid: null,
		});
	});

	it("recognises the encoder's own partial and reads its pid", () => {
		// 4242 in base 36 is "39u"; the name is what a real run left behind.
		expect(classifyExportTempName("demo.render-abc12345.partial-39u-ffcfe007.mp4")).toEqual({
			kind: "encoder-partial",
			pid: 4242,
		});
		expect(classifyExportTempName("holiday.partial-t2w-deadbeef.mp4")).toEqual({
			kind: "encoder-partial",
			pid: Number.parseInt("t2w", 36),
		});
	});

	it("recognises the GIF partial, which carries a decimal pid", () => {
		expect(classifyExportTempName(".openscreen-gif-41234-9f3a.partial")).toEqual({
			kind: "gif-partial",
			pid: 41234,
		});
	});

	it("refuses an ordinary export, a project, and a stage-shaped name that is too short", () => {
		expect(classifyExportTempName("holiday.mp4")).toBeNull();
		expect(classifyExportTempName("demo.gif")).toBeNull();
		expect(classifyExportTempName("demo.openscreen")).toBeNull();
		// The token is what proves this app made it; four characters is not a token.
		expect(classifyExportTempName("demo.render-abcd.mp4")).toBeNull();
		expect(classifyExportTempName("demo.partial-x.mp4")).toBeNull();
	});
});

describe("sweepStaleExportTemps — what it removes", () => {
	it("leaves an expired render stage alone: a name is not ownership", async () => {
		await write("demo.render-mw82t9k6-4qhjjaaa.mp4", 2 * DAY);
		const notes: string[] = [];
		const result = await sweepStaleExportTemps(dir, {
			now: Date.now(),
			note: (message) => notes.push(message),
		});
		expect(result.removed).toEqual([]);
		expect(result.kept).toEqual([
			{ path: path.join(dir, "demo.render-mw82t9k6-4qhjjaaa.mp4"), reason: "unattributable" },
		]);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("unattributable");
		expect(await names()).toEqual(["demo.render-mw82t9k6-4qhjjaaa.mp4"]);
	});

	it("leaves an expired mixed stage alone for the same reason", async () => {
		await write("demo.mixed-mw82t9k6-4qhjjaaa.mp4", 2 * DAY);
		const result = await sweepStaleExportTemps(dir, { now: Date.now() });
		expect(result.removed).toEqual([]);
		expect(result.kept.map((k) => k.reason)).toEqual(["unattributable"]);
	});

	it("removes an encoder partial whose process is gone", async () => {
		await write("demo.partial-t2w-ffcfe007.mp4", 2 * DAY);
		const result = await sweepStaleExportTemps(dir, {
			now: Date.now(),
			processState: () => "dead",
		});
		expect(result.removed).toEqual(["demo.partial-t2w-ffcfe007.mp4"]);
	});
});

describe("sweepStaleExportTemps — what it must keep", () => {
	it("keeps the export this process is writing right now", async () => {
		const live = await write("demo.render-aaaaaaaa.mp4", 2 * DAY);
		const result = await sweepStaleExportTemps(dir, {
			now: Date.now(),
			activePaths: [live],
		});
		expect(result.removed).toEqual([]);
		expect(result.kept.map((k) => k.reason)).toContain("active");
		expect(await names()).toEqual(["demo.render-aaaaaaaa.mp4"]);
	});

	it("keeps a partial whose pid is still alive", async () => {
		await write("demo.partial-t2w-ffcfe007.mp4", 2 * DAY);
		const result = await sweepStaleExportTemps(dir, {
			now: Date.now(),
			processState: (pid) => (pid === Number.parseInt("t2w", 36) ? "alive" : "dead"),
		});
		expect(result.removed).toEqual([]);
		expect(result.kept.map((k) => k.reason)).toContain("process-alive");
	});

	it("keeps an old stage another CLI process is still using (no pid, no proof)", async () => {
		// The case V2.5 could not answer: another `openscreen export` in a terminal is writing
		// `clip.mixed-<token>.mp4` right now. It is old only because that export is long, and the
		// name carries nothing to attribute it to. Deleting it would corrupt a live run.
		await write("clip.mixed-9f3a1c2b4d.mp4", 3 * DAY);
		const result = await sweepStaleExportTemps(dir, { now: Date.now() });
		expect(result.removed).toEqual([]);
		expect(await names()).toEqual(["clip.mixed-9f3a1c2b4d.mp4"]);
	});

	it("keeps a user's ordinary MP4 that happens to match the stage pattern", async () => {
		// Someone renamed their own file into our naming convention, or a backup tool did. There
		// is nothing in the name that proves this app wrote it.
		await write("holiday.render-20240101.mp4", 90 * DAY);
		const result = await sweepStaleExportTemps(dir, { now: Date.now() });
		expect(result.removed).toEqual([]);
		expect(await names()).toEqual(["holiday.render-20240101.mp4"]);
	});

	it("keeps a partial when the OS cannot say whether its pid is alive", async () => {
		// EPERM (another account) or an errno this platform does not implement: unknown is not
		// "dead", because the cost of guessing wrong is someone else's file.
		await write("demo.partial-t2w-ffcfe007.mp4", 3 * DAY);
		const result = await sweepStaleExportTemps(dir, {
			now: Date.now(),
			processState: () => "unknown",
		});
		expect(result.removed).toEqual([]);
		expect(result.kept.map((k) => k.reason)).toContain("process-unknown");
	});

	it("keeps a file that has not expired", async () => {
		// Five minutes old: an export that just started, or one that just crashed, looks exactly
		// like this. Only a pid-carrying name can reach the age rule at all.
		await write("demo.partial-t2w-ffcfe007.mp4", 5 * 60 * 1000);
		const result = await sweepStaleExportTemps(dir, {
			now: Date.now(),
			processState: () => "dead",
		});
		expect(result.removed).toEqual([]);
		expect(result.kept.map((k) => k.reason)).toContain("not-expired");
	});

	it("keeps a normal MP4 and the footage the project reads", async () => {
		await write("holiday.mp4", 30 * DAY);
		await write("screen-capture - copy.mp4", 30 * DAY);
		await write("demo.openscreen", 30 * DAY);
		const result = await sweepStaleExportTemps(dir, { now: Date.now() });
		expect(result.removed).toEqual([]);
		expect(await names()).toHaveLength(3);
	});

	it("does not recurse into a subdirectory", async () => {
		const sub = path.join(dir, "old");
		await fs.mkdir(sub);
		const inside = path.join(sub, "demo.render-cccccccc.mp4");
		await fs.writeFile(inside, "x");
		await sweepStaleExportTemps(dir, { now: Date.now() });
		expect(await fs.readFile(inside, "utf8")).toBe("x");
	});

	// Creating a file symlink needs SeCreateSymbolicLinkPrivilege on Windows, which this
	// machine does not grant. The guard it would exercise is `entry.isFile()`, false for a
	// symlink dirent; the POSIX run in CI covers it.
	it.skipIf(process.platform === "win32")(
		"does not follow a symlink that points at a real export",
		async () => {
			const real = path.join(dir, "holiday.mp4");
			await fs.writeFile(real, "the user's file");
			const link = path.join(dir, "demo.render-dddddddd.mp4");
			await fs.symlink(real, link);
			const result = await sweepStaleExportTemps(dir, { now: Date.now() });
			expect(result.removed).toEqual([]);
			expect(await fs.readFile(real, "utf8")).toBe("the user's file");
		},
	);
});

describe("sweepStaleExportTemps — it can never break an export", () => {
	it("reports a failed delete as a warning and keeps going", async () => {
		await write("demo.partial-t2w-ffcfe007.mp4", 2 * DAY);
		await write("demo.partial-t2w-aaaaaaaa.mp4", 2 * DAY);
		const warnings: string[] = [];
		// The first unlink fails the way a locked file does; the sweep must not throw.
		const unlink = vi
			.spyOn(fs, "unlink")
			.mockRejectedValueOnce(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
		const result = await sweepStaleExportTemps(dir, {
			now: Date.now(),
			processState: () => "dead",
			warn: (message) => warnings.push(message),
		});
		unlink.mockRestore();
		expect(warnings).toHaveLength(1);
		// `readdir` order is not part of the contract, so the warning must name whichever file
		// survived — and exactly one file must have survived.
		const survivor = (await names())[0];
		expect(warnings[0]).toContain(survivor);
		expect(result.removed).toHaveLength(1);
		expect(result.removed[0]).not.toBe(survivor);
	});

	it("returns quietly when the directory does not exist", async () => {
		const warnings: string[] = [];
		const result = await sweepStaleExportTemps(path.join(dir, "nope"), {
			warn: (message) => warnings.push(message),
		});
		expect(result).toEqual({ removed: [], kept: [] });
		expect(warnings).toHaveLength(0);
	});

	it("is idempotent: a second pass finds nothing and throws nothing", async () => {
		await write("demo.partial-t2w-ffcfe007.mp4", 2 * DAY);
		const options = { now: Date.now(), processState: () => "dead" as const };
		const first = await sweepStaleExportTemps(dir, options);
		const second = await sweepStaleExportTemps(dir, options);
		expect(first.removed).toHaveLength(1);
		expect(second).toEqual({ removed: [], kept: [] });
	});
});
