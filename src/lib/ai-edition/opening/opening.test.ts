// Opening Motion — the parser and the identity rule.
//
// The native side reads this contract (`SceneOpening` in `crates/compositor/src/scene.rs`);
// what is pinned here is that the TS half repairs rather than rejects. A project with a
// hand-edited or half-written opening must still open, and must still render exactly as it
// did before the opening existed whenever the flag is off.
import { describe, expect, it } from "vitest";
import {
	DEFAULT_OPENING_DURATION_SEC,
	DEFAULT_OPENING_STAGGER_SEC,
	defaultOpeningSequence,
	isOpeningIdentity,
	MAX_OPENING_DURATION_SEC,
	MAX_OPENING_STAGGER_SEC,
	MIN_OPENING_DURATION_SEC,
	maxStaggerForDuration,
	OPENING_CURVE_SWIFT,
	OPENING_ELEMENT_CAMERA,
	OPENING_ELEMENT_SCREEN,
	OPENING_KNOWN_PRESETS,
	OPENING_PRESET_CONVERGE,
	OPENING_PRESET_LIGHT_3D,
	OPENING_PRESET_SIDE_SLIDE,
	parseOpeningSequence,
} from "@/lib/ai-edition/opening/opening";

describe("opening: a project without one", () => {
	it("reads as disabled, with the shipped defaults", () => {
		const opening = parseOpeningSequence(null);
		expect(opening.enabled).toBe(false);
		expect(opening.preset).toBe(OPENING_PRESET_SIDE_SLIDE);
		expect(opening.curve).toBe(OPENING_CURVE_SWIFT);
		expect(opening.durationSec).toBe(DEFAULT_OPENING_DURATION_SEC);
		expect(opening.staggerSec).toBe(DEFAULT_OPENING_STAGGER_SEC);
		expect(opening.elementOrder).toEqual([OPENING_ELEMENT_SCREEN, OPENING_ELEMENT_CAMERA]);
		expect(opening.includedElements).toEqual([OPENING_ELEMENT_SCREEN, OPENING_ELEMENT_CAMERA]);
	});

	it("is the identity, so an old project renders unchanged", () => {
		// This is the whole compatibility promise: no opening field, no visual difference.
		expect(isOpeningIdentity(parseOpeningSequence(undefined))).toBe(true);
		expect(isOpeningIdentity(defaultOpeningSequence())).toBe(true);
	});

	it("treats a non-object as absent rather than throwing", () => {
		for (const value of [null, undefined, 0, "", "sideSlide", [], true]) {
			const opening = parseOpeningSequence(value);
			expect(opening.enabled).toBe(false);
			expect(opening.durationSec).toBe(DEFAULT_OPENING_DURATION_SEC);
		}
	});
});

describe("opening: the enabled flag is read strictly", () => {
	it("only a literal true switches it on", () => {
		// A stray string or number in a hand-edited file must not turn an animation on.
		expect(parseOpeningSequence({ enabled: true }).enabled).toBe(true);
		for (const value of ["true", 1, {}, [], "yes"]) {
			expect(parseOpeningSequence({ enabled: value }).enabled).toBe(false);
		}
	});

	it("enabled with nothing selected is still the identity", () => {
		const opening = parseOpeningSequence({ enabled: true, includedElements: [] });
		expect(opening.enabled).toBe(true);
		expect(isOpeningIdentity(opening)).toBe(true);
	});
});

describe("opening: duration and stagger are repaired into range", () => {
	it("clamps a duration to the slider's bounds", () => {
		expect(parseOpeningSequence({ durationSec: 0.01 }).durationSec).toBe(MIN_OPENING_DURATION_SEC);
		expect(parseOpeningSequence({ durationSec: 999 }).durationSec).toBe(MAX_OPENING_DURATION_SEC);
		expect(parseOpeningSequence({ durationSec: 3 }).durationSec).toBe(3);
	});

	it("falls back on a non-finite duration instead of propagating NaN", () => {
		// NaN in a duration would become a NaN rect, which is a black frame.
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(parseOpeningSequence({ durationSec: value }).durationSec).toBe(
				DEFAULT_OPENING_DURATION_SEC,
			);
		}
	});

	it("clamps the stagger, and never lets it outlast the duration", () => {
		expect(parseOpeningSequence({ staggerSec: -1 }).staggerSec).toBe(0);
		expect(parseOpeningSequence({ staggerSec: 99 }).staggerSec).toBe(MAX_OPENING_STAGGER_SEC);
		// The bound the native side applies too: past 80% of the duration the second element
		// would start after the opening had already ended.
		const tight = parseOpeningSequence({ durationSec: 1, staggerSec: 5 });
		expect(tight.staggerSec).toBeLessThanOrEqual(tight.durationSec);
		expect(tight.staggerSec).toBeCloseTo(1 * 0.8, 6);
	});

	it("reports the stagger bound the sliders should offer", () => {
		expect(maxStaggerForDuration(2.2)).toBeCloseTo(MAX_OPENING_STAGGER_SEC, 6);
		expect(maxStaggerForDuration(0.4)).toBeCloseTo(0.4 * 0.8, 6);
	});
});

describe("opening: element lists are cleaned up", () => {
	it("drops names the preset does not know", () => {
		const opening = parseOpeningSequence({
			elementOrder: ["sticker", "camera", "screen"],
			includedElements: ["converge", "screen"],
		});
		// `sticker` / `converge` are later rounds; unknown, so ignored rather than kept.
		expect(opening.elementOrder).toEqual([OPENING_ELEMENT_CAMERA, OPENING_ELEMENT_SCREEN]);
		expect(opening.includedElements).toEqual([OPENING_ELEMENT_SCREEN]);
	});

	it("de-duplicates", () => {
		const opening = parseOpeningSequence({
			elementOrder: ["screen", "screen", "camera"],
			includedElements: ["screen", "screen"],
		});
		expect(opening.elementOrder).toEqual([OPENING_ELEMENT_SCREEN, OPENING_ELEMENT_CAMERA]);
		expect(opening.includedElements).toEqual([OPENING_ELEMENT_SCREEN]);
	});

	it("fills the order in, because both elements need a rank", () => {
		expect(parseOpeningSequence({ elementOrder: [] }).elementOrder).toEqual([
			OPENING_ELEMENT_SCREEN,
			OPENING_ELEMENT_CAMERA,
		]);
		expect(parseOpeningSequence({ elementOrder: ["camera"] }).elementOrder).toEqual([
			OPENING_ELEMENT_CAMERA,
			OPENING_ELEMENT_SCREEN,
		]);
	});

	it("keeps an order swap", () => {
		const opening = parseOpeningSequence({ elementOrder: ["camera", "screen"] });
		expect(opening.elementOrder).toEqual([OPENING_ELEMENT_CAMERA, OPENING_ELEMENT_SCREEN]);
	});

	it("leaves the selection alone when only one element is chosen", () => {
		// The normal case for a project with no camera: the screen still enters.
		const opening = parseOpeningSequence({ enabled: true, includedElements: ["screen"] });
		expect(opening.includedElements).toEqual([OPENING_ELEMENT_SCREEN]);
		expect(isOpeningIdentity(opening)).toBe(false);
	});

	it("survives a selection that is not an array", () => {
		const opening = parseOpeningSequence({ includedElements: "screen" });
		expect(opening.includedElements).toEqual([]);
		// Nothing selected → identity, so a corrupt list cannot animate a project by accident.
		expect(isOpeningIdentity(opening)).toBe(true);
	});
});

describe("opening: the preset is an allowlist", () => {
	it("reads the two presets this build ships", () => {
		expect(parseOpeningSequence({ preset: OPENING_PRESET_SIDE_SLIDE }).preset).toBe(
			OPENING_PRESET_SIDE_SLIDE,
		);
		expect(parseOpeningSequence({ preset: OPENING_PRESET_CONVERGE }).preset).toBe(
			OPENING_PRESET_CONVERGE,
		);
		expect(parseOpeningSequence({ preset: OPENING_PRESET_LIGHT_3D }).preset).toBe(
			OPENING_PRESET_LIGHT_3D,
		);
	});

	it("ships exactly the three presets, spelled the way the native side spells them", () => {
		// The strings are a wire contract with `opening.rs`'s `PRESET_*` constants: a rename on
		// either side silently becomes "unknown", which the parser repairs to sideSlide — the app
		// would show one thing and the compositor draw another.
		expect([...OPENING_KNOWN_PRESETS]).toEqual(["sideSlide", "converge", "light3D"]);
	});

	it("normalises an unknown name to the default rather than storing it", () => {
		// The point of the allowlist. Storing `"light3d"` verbatim would leave the app showing a
		// value it recognises while the native side repaired the same document to `sideSlide` —
		// the document would say one thing and the picture another. What is stored is what is
		// drawn, so the repair happens here too.
		for (const name of ["light3d", "Sticker", "side-slide", "CONVERGE", "converge ", ""]) {
			expect(parseOpeningSequence({ preset: name }).preset).toBe(OPENING_PRESET_SIDE_SLIDE);
		}
		for (const value of [null, undefined, 7, {}, [], true]) {
			expect(parseOpeningSequence({ preset: value }).preset).toBe(OPENING_PRESET_SIDE_SLIDE);
		}
	});

	it("agrees with itself on every name in the allowlist", () => {
		// A parse that changed its mind would make save/reopen differ from the live document.
		for (const preset of OPENING_KNOWN_PRESETS) {
			const once = parseOpeningSequence({ enabled: true, preset });
			expect(once.preset).toBe(preset);
			expect(parseOpeningSequence(JSON.parse(JSON.stringify(once)))).toEqual(once);
		}
	});

	it("keeps a converge opening through a save and reopen", () => {
		const stored = {
			enabled: true,
			preset: OPENING_PRESET_CONVERGE,
			durationSec: 3.4,
			staggerSec: 0.42,
			curve: OPENING_CURVE_SWIFT,
			elementOrder: ["camera", "screen"],
			includedElements: ["screen", "camera"],
		};
		expect(parseOpeningSequence(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
	});

	it("does not make the preset a reason to change the other fields", () => {
		// A preset owns the departure geometry and nothing else: parsing the same object with a
		// different preset must leave duration, stagger and both lists identical.
		const base = {
			enabled: true,
			durationSec: 4,
			staggerSec: 0.5,
			elementOrder: ["camera", "screen"],
			includedElements: ["screen"],
		};
		const slide = parseOpeningSequence({ ...base, preset: OPENING_PRESET_SIDE_SLIDE });
		const converge = parseOpeningSequence({ ...base, preset: OPENING_PRESET_CONVERGE });
		expect(converge.durationSec).toBe(slide.durationSec);
		expect(converge.staggerSec).toBe(slide.staggerSec);
		expect(converge.elementOrder).toEqual(slide.elementOrder);
		expect(converge.includedElements).toEqual(slide.includedElements);
		expect(converge.curve).toBe(slide.curve);
		expect(converge.preset).not.toBe(slide.preset);
	});
});

describe("opening: a round-trip through JSON keeps every field", () => {
	it("survives save and reopen", () => {
		const stored = {
			enabled: true,
			preset: OPENING_PRESET_SIDE_SLIDE,
			durationSec: 3.4,
			staggerSec: 0.42,
			curve: OPENING_CURVE_SWIFT,
			elementOrder: ["camera", "screen"],
			includedElements: ["screen"],
		};
		// save: what the writer serialises. load: what the parser reads back.
		const read = parseOpeningSequence(JSON.parse(JSON.stringify(stored)));
		expect(read).toEqual(stored);
	});

	it("is stable — parsing a parsed value changes nothing", () => {
		const once = parseOpeningSequence({ enabled: true, durationSec: 1.5, staggerSec: 0.9 });
		const twice = parseOpeningSequence(JSON.parse(JSON.stringify(once)));
		expect(twice).toEqual(once);
	});
});
