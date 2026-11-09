import { describe, expect, it } from "vitest";
import { ShortcutCollector, shortcutCombo, shortcutKeyLabel } from "./shortcuts";

/**
 * The privacy contract, stated as tests. Every case here is a key that a user
 * could press while the option is on, and the expected answer is about what the
 * project is allowed to remember — not about formatting.
 */
describe("shortcut filtering", () => {
	const none = { ctrl: false, alt: false, shift: false, win: false };

	it("names the keys a shortcut can be built from", () => {
		expect(shortcutKeyLabel(0x53)).toBe("S");
		expect(shortcutKeyLabel(0x31)).toBe("1");
		expect(shortcutKeyLabel(0x70)).toBe("F1");
		expect(shortcutKeyLabel(0x78)).toBe("F9");
		expect(shortcutKeyLabel(0x09)).toBe("Tab");
		expect(shortcutKeyLabel(0x25)).toBe("Left");
	});

	it("refuses every key outside the whitelist", () => {
		expect(shortcutKeyLabel(0xbc)).toBeNull(); // OEM comma
		expect(shortcutKeyLabel(0xdb)).toBeNull(); // OEM bracket
		expect(shortcutKeyLabel(0x14)).toBeNull(); // CapsLock
		expect(shortcutKeyLabel(0)).toBeNull();
	});

	it("never records a bare key: Shift alone is how a capital letter is typed", () => {
		expect(shortcutCombo(0x53, none)).toBeNull();
		expect(shortcutCombo(0x53, { ...none, shift: true })).toBeNull();
		expect(shortcutCombo(0x41, { ...none, shift: true })).toBeNull();
	});

	it("builds the label in a fixed modifier order", () => {
		expect(shortcutCombo(0x53, { ctrl: true, alt: false, shift: false, win: false })).toBe(
			"Ctrl+S",
		);
		expect(shortcutCombo(0x78, { ctrl: true, alt: true, shift: false, win: false })).toBe(
			"Ctrl+Alt+F9",
		);
		expect(shortcutCombo(0x09, { ctrl: false, alt: false, shift: true, win: true })).toBe(
			"Shift+Win+Tab",
		);
		expect(shortcutCombo(0x53, { ctrl: true, alt: false, shift: false, win: true })).toBe(
			"Ctrl+Win+S",
		);
	});

	it("drops a chord whose key is not on the whitelist, even with Ctrl held", () => {
		expect(shortcutCombo(0xbc, { ctrl: true, alt: false, shift: false, win: false })).toBeNull();
	});
});

describe("ShortcutCollector", () => {
	const ctrl = { ctrl: true, alt: false, shift: false, win: false };

	it("keeps one entry per press and drops the OS auto-repeat", () => {
		const collector = new ShortcutCollector();
		expect(collector.push(1000, 0x53, ctrl)).toBe(true);
		expect(collector.push(1100, 0x53, ctrl)).toBe(false);
		expect(collector.push(1300, 0x53, ctrl)).toBe(false);
		// Past the repeat window a genuine second press is kept.
		expect(collector.push(1700, 0x53, ctrl)).toBe(true);
		expect(collector.list()).toEqual([
			{ timeMs: 1000, combo: "Ctrl+S" },
			{ timeMs: 1700, combo: "Ctrl+S" },
		]);
	});

	it("records a different chord inside the repeat window", () => {
		const collector = new ShortcutCollector();
		collector.push(1000, 0x53, ctrl);
		expect(collector.push(1100, 0x56, ctrl)).toBe(true);
		expect(collector.list().map((entry) => entry.combo)).toEqual(["Ctrl+S", "Ctrl+V"]);
	});

	it("bounds the array and counts what it dropped", () => {
		const collector = new ShortcutCollector(3);
		for (let i = 0; i < 6; i++) collector.push(1000 + i * 1000, 0x53 + i, ctrl);
		expect(collector.list()).toHaveLength(3);
		expect(collector.list()[2]?.combo).toBe("Ctrl+X");
		expect(collector.droppedCount()).toBe(3);
	});

	it("refuses a negative or non-finite time without keeping the chord", () => {
		const collector = new ShortcutCollector();
		expect(collector.push(-5, 0x53, ctrl)).toBe(false);
		expect(collector.push(Number.NaN, 0x53, ctrl)).toBe(false);
		expect(collector.list()).toHaveLength(0);
	});
});
