import { beforeEach, describe, expect, it, vi } from "vitest";

const { start, stop } = vi.hoisted(() => {
	let nextId = 1;
	return { start: vi.fn(() => nextId++), stop: vi.fn() };
});

vi.mock("electron", () => ({ powerSaveBlocker: { start, stop } }));

describe("setDisplaySleepBlocked", () => {
	let setDisplaySleepBlocked: (recording: boolean) => void;

	beforeEach(async () => {
		vi.resetModules();
		start.mockClear();
		stop.mockClear();
		({ setDisplaySleepBlocked } = await import("./displaySleepBlocker"));
	});

	it("starts one display-sleep blocker per recording and stops that same one", () => {
		setDisplaySleepBlocked(true);
		expect(start).toHaveBeenCalledOnce();
		expect(start).toHaveBeenCalledWith("prevent-display-sleep");

		setDisplaySleepBlocked(false);
		expect(stop).toHaveBeenCalledOnce();
		expect(stop).toHaveBeenCalledWith(start.mock.results[0].value);
	});

	it("never stacks a second blocker when a start is reported twice", () => {
		setDisplaySleepBlocked(true);
		setDisplaySleepBlocked(true);
		setDisplaySleepBlocked(false);
		expect(start).toHaveBeenCalledOnce();
		expect(stop).toHaveBeenCalledOnce();
	});

	it("ignores a stop with nothing started, as a failed start then cancel reports", () => {
		setDisplaySleepBlocked(false);
		expect(stop).not.toHaveBeenCalled();
	});

	it("leaves nothing running across consecutive takes", () => {
		for (let take = 0; take < 3; take++) {
			setDisplaySleepBlocked(true);
			setDisplaySleepBlocked(false);
			setDisplaySleepBlocked(false);
		}
		expect(start).toHaveBeenCalledTimes(3);
		expect(stop.mock.calls.map(([id]) => id)).toEqual(start.mock.results.map((r) => r.value));
	});
});
