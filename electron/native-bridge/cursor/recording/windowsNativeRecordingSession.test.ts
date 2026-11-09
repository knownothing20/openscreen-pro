import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.fn();
const dipToScreenRect = vi.fn();

vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawn(...args) }));
vi.mock("electron", () => ({
	app: { getAppPath: () => "C:\\app", isPackaged: false },
	screen: {
		dipToScreenRect: (...args: unknown[]) => dipToScreenRect(...args),
		screenToDipPoint: (p: unknown) => p,
		getDisplayNearestPoint: () => ({ scaleFactor: 1, bounds: DIP_BOUNDS }),
		getPrimaryDisplay: () => ({ bounds: DIP_BOUNDS }),
	},
}));

import { WindowsNativeRecordingSession } from "./windowsNativeRecordingSession";

/** A 1920x1080 panel at 187.5%, the arrangement measured while fixing #346. */
const DIP_BOUNDS = { x: 0, y: 0, width: 1024, height: 576 };
const PHYSICAL_BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 };

function fakeHelper() {
	// Push-only streams: the test feeds them, so `_read` has nothing to do.
	const noPull = () => undefined;
	const stdout = new Readable({ read: noPull });
	const stderr = new Readable({ read: noPull });
	const child = Object.assign(new EventEmitter(), { stdout, stderr, pid: 4242, kill: vi.fn() });
	return { child, stdout };
}

/**
 * The unit test on `toHelperRect` proves the conversion works; it cannot prove
 * this file still calls it. That is the half that broke in #346 — the recorder
 * and the cursor telemetry each decided for themselves which space they were in
 * — so pin the two branches that decision has.
 */
describe("WindowsNativeRecordingSession bounds handling", () => {
	const REAL_PLATFORM = process.platform;
	const setPlatform = (value: NodeJS.Platform) =>
		Object.defineProperty(process, "platform", { value, configurable: true });

	beforeEach(() => {
		setPlatform("win32");
		// First candidate in the lookup, so nothing has to exist on disk but this.
		process.env.OPENSCREEN_CURSOR_SAMPLER_EXE = __filename;
		dipToScreenRect.mockReturnValue(PHYSICAL_BOUNDS);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.spyOn(console, "info").mockImplementation(() => undefined);
	});

	afterEach(() => {
		setPlatform(REAL_PLATFORM);
		process.env.OPENSCREEN_CURSOR_SAMPLER_EXE = undefined;
		spawn.mockReset();
		dipToScreenRect.mockReset();
		vi.restoreAllMocks();
	});

	const run = async (sample: Record<string, unknown>) => {
		const { child, stdout } = fakeHelper();
		spawn.mockReturnValue(child);
		const session = new WindowsNativeRecordingSession({
			getDisplayBounds: () => DIP_BOUNDS,
			maxSamples: 10,
			sampleIntervalMs: 33,
			startTimeMs: 1000,
		});
		const started = session.start();
		stdout.push(`${JSON.stringify({ type: "ready", timestampMs: 1000 })}\n`);
		await started;
		stdout.push(`${JSON.stringify(sample)}\n`);
		await new Promise((resolve) => setImmediate(resolve));
		return (await session.stop()).samples;
	};

	it("normalizes a display capture against the physical rect, not the DIP one", async () => {
		const samples = await run({
			type: "sample",
			timestampMs: 1100,
			x: 1440,
			y: 538,
			visible: true,
			handle: null,
			asset: null,
		});

		expect(dipToScreenRect).toHaveBeenCalledWith(null, DIP_BOUNDS);
		// 1440/1920, not 1440/1024 — the latter is 1.40625 and lands off-frame.
		expect(samples[0].cx).toBeCloseTo(0.75, 5);
		expect(samples[0].cy).toBeCloseTo(538 / 1080, 5);
	});

	it("uses the sampler's own bounds as-is for a window capture", async () => {
		const samples = await run({
			type: "sample",
			timestampMs: 1100,
			x: 900,
			y: 500,
			visible: true,
			handle: "0x10003",
			bounds: { x: 100, y: 100, width: 800, height: 600 },
			asset: null,
		});

		// GetWindowRect is already physical, so converting it again would be wrong.
		expect(dipToScreenRect).not.toHaveBeenCalled();
		expect(samples[0].cx).toBeCloseTo((900 - 100) / 800, 5);
		expect(samples[0].cy).toBeCloseTo((500 - 100) / 600, 5);
	});
});

/**
 * The event channel itself: the steady clock, the three buttons, the wheel, and
 * the shortcut filter as it is wired — a unit test on the filter proves the rule,
 * not that the session applies it or that `--keys` is ever passed.
 */
describe("WindowsNativeRecordingSession event channel", () => {
	const REAL_PLATFORM = process.platform;
	const setPlatform = (value: NodeJS.Platform) =>
		Object.defineProperty(process, "platform", { value, configurable: true });

	beforeEach(() => {
		setPlatform("win32");
		process.env.OPENSCREEN_CURSOR_SAMPLER_EXE = __filename;
		dipToScreenRect.mockReturnValue(PHYSICAL_BOUNDS);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.spyOn(console, "info").mockImplementation(() => undefined);
	});

	afterEach(() => {
		setPlatform(REAL_PLATFORM);
		process.env.OPENSCREEN_CURSOR_SAMPLER_EXE = undefined;
		spawn.mockReset();
		dipToScreenRect.mockReset();
		vi.restoreAllMocks();
	});

	const start = async (options: { captureShortcuts?: boolean } = {}) => {
		const { child, stdout } = fakeHelper();
		spawn.mockReturnValue(child);
		const session = new WindowsNativeRecordingSession({
			getDisplayBounds: () => DIP_BOUNDS,
			maxSamples: 200,
			sampleIntervalMs: 20,
			startTimeMs: 9_000,
			...options,
		});
		const started = session.start();
		// Wall clock 10 000 at steady 5 000: the helper started 1 000 ms after the take.
		stdout.push(
			`${JSON.stringify({ type: "ready", timestampMs: 10_000, monotonicMs: 5_000, shortcuts: true })}\n`,
		);
		await started;
		const push = async (event: Record<string, unknown>) => {
			stdout.push(`${JSON.stringify(event)}\n`);
			await new Promise((resolve) => setImmediate(resolve));
		};
		return { session, push, spawnArgs: spawn.mock.calls.at(-1)?.[1] as string[] };
	};

	const baseSample = (monotonicMs: number, extra: Record<string, unknown> = {}) => ({
		type: "sample",
		timestampMs: 10_000 + (monotonicMs - 5_000),
		monotonicMs,
		x: 480,
		y: 270,
		visible: true,
		handle: "0x1",
		bounds: PHYSICAL_BOUNDS,
		asset: null,
		...extra,
	});

	it("maps the steady clock onto the take instead of trusting the wall clock", async () => {
		const { session, push } = await start();
		await push(baseSample(5_500));
		const [sample] = (await session.stop()).samples;
		// 500 ms after ready, plus the 1 000 ms between take start and ready.
		expect(sample.timeMs).toBe(1_500);
	});

	it("survives a wall-clock jump because the mapping never reads it again", async () => {
		const { session, push } = await start();
		// The wall clock jumps forward an hour; the steady clock advances 200 ms.
		await push({ ...baseSample(5_200), timestampMs: 10_000 + 3_600_000 + 200 });
		await push({ ...baseSample(5_400), timestampMs: 10_000 + 3_600_000 + 400 });
		const [first, second] = (await session.stop()).samples;
		expect(first.timeMs).toBe(1_200);
		expect(second.timeMs).toBe(1_400);
	});

	it("records right and middle presses as their own kinds", async () => {
		const { session, push } = await start();
		await push(baseSample(5_100, { rightButtonPressed: true, rightButtonDown: true }));
		await push(baseSample(5_200, { rightButtonDown: false }));
		await push(baseSample(5_400, { middleButtonPressed: true, middleButtonDown: true }));
		const samples = (await session.stop()).samples;
		expect(samples.map((sample) => sample.interactionType)).toEqual([
			"right-click",
			"mouseup",
			"middle-click",
		]);
	});

	it("folds a second press close in time and space into one double-click", async () => {
		const { session, push } = await start();
		await push(baseSample(5_100, { leftButtonPressed: true, leftButtonDown: true }));
		await push(baseSample(5_150, { leftButtonDown: false }));
		await push(baseSample(5_220, { leftButtonPressed: true, leftButtonDown: true }));
		await push(baseSample(5_270, { leftButtonDown: false }));
		const kinds = (await session.stop()).samples.map((sample) => sample.interactionType);
		// One action: the first press is folded away, the second names the double click.
		expect(kinds).toEqual(["move", "mouseup", "double-click", "mouseup"]);
	});

	it("keeps two clicks apart as two clicks", async () => {
		const { session, push } = await start();
		await push(baseSample(5_100, { leftButtonPressed: true, leftButtonDown: true }));
		await push(baseSample(5_150, { leftButtonDown: false }));
		await push(baseSample(6_000, { leftButtonPressed: true, leftButtonDown: true }));
		const kinds = (await session.stop()).samples.map((sample) => sample.interactionType);
		expect(kinds).toEqual(["click", "mouseup", "click"]);
	});

	it("keeps the wheel delta only on the sample that saw it", async () => {
		const { session, push } = await start();
		await push(baseSample(5_100, { wheelDelta: 120 }));
		await push(baseSample(5_200));
		const samples = (await session.stop()).samples;
		expect(samples[0].wheelDelta).toBe(120);
		expect(samples[1].wheelDelta).toBeUndefined();
	});

	it("asks for the shortcut channel only when the take opted in", async () => {
		const off = await start();
		expect(off.spawnArgs).not.toContain("--keys");
		await off.session.stop();

		const on = await start({ captureShortcuts: true });
		expect(on.spawnArgs).toContain("--keys");
		await on.session.stop();
	});

	it("stores filtered shortcuts, and drops a chord the filter refuses", async () => {
		const { session, push } = await start({ captureShortcuts: true });
		await push({
			type: "shortcut",
			timestampMs: 10_100,
			monotonicMs: 5_100,
			vk: 0x53,
			ctrl: true,
			alt: false,
			shift: false,
			win: false,
		});
		await push({
			type: "shortcut",
			timestampMs: 10_150,
			monotonicMs: 5_150,
			vk: 0x41,
			ctrl: false,
			alt: false,
			shift: true,
			win: false,
		});
		const data = await session.stop();
		expect(data.version).toBe(3);
		expect(data.shortcuts).toEqual([{ timeMs: 1_100, combo: "Ctrl+S" }]);
	});
});
