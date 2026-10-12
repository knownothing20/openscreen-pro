// Every locale must define every key `en` defines.
//
// The loader silently falls back to `en` for a missing key (see `translate` in
// `../loader.ts`), so an untranslated block doesn't crash — it just renders in
// English forever. That is exactly how the whole `settings.captions` pane
// shipped English-only in 11 locales. A per-feature test with a hand-written key
// list can't catch the next one; this walks the files instead.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CAMERA_MOTION_EASINGS } from "@/lib/ai-edition/cameraMotion/easingNames";

// `import.meta.url` isn't a file: URL under the test environment's transform.
const LOCALES_DIR = resolve(process.cwd(), "src/i18n/locales");
const REFERENCE_LOCALE = "en";

function flatten(value: unknown, prefix = ""): string[] {
	if (value == null || typeof value !== "object" || Array.isArray(value))
		return [prefix.slice(0, -1)];
	return Object.entries(value).flatMap(([key, child]) => flatten(child, `${prefix}${key}.`));
}

function keysOf(locale: string, namespace: string): string[] {
	return flatten(JSON.parse(readFileSync(`${LOCALES_DIR}/${locale}/${namespace}`, "utf8")));
}

const namespaces = readdirSync(`${LOCALES_DIR}/${REFERENCE_LOCALE}`).filter((f) =>
	f.endsWith(".json"),
);
const locales = readdirSync(LOCALES_DIR).filter((l) => l !== REFERENCE_LOCALE);

describe("locale parity", () => {
	it.each(locales)("%s defines every key en defines", (locale) => {
		const missing = namespaces.flatMap((namespace) => {
			const translated = new Set(keysOf(locale, namespace));
			return keysOf(REFERENCE_LOCALE, namespace)
				.filter((key) => !translated.has(key))
				.map((key) => `${namespace.replace(".json", "")}.${key}`);
		});
		expect(missing).toEqual([]);
	});
});

// The Inspector builds these keys at RUNTIME — `tt(\`easingNames.${easing}\`)` — so the
// literal-key checker in `scripts/i18n-check.mjs` cannot see them, and neither can the
// parity test above (which only compares the files to each other). A typo would therefore
// print the raw key in the dropdown and fail nothing. The curve list comes from the model,
// so adding a curve without a name fails here.
describe("motion easing names", () => {
	it("has a `timeline.easingNames` entry for every curve the Inspector offers", () => {
		const names = (
			JSON.parse(readFileSync(`${LOCALES_DIR}/${REFERENCE_LOCALE}/timeline.json`, "utf8")) as {
				easingNames?: Record<string, string>;
			}
		).easingNames;
		expect(names).toBeDefined();
		for (const easing of CAMERA_MOTION_EASINGS) {
			expect(names?.[easing], `timeline.easingNames.${easing}`).toBeTruthy();
		}
	});
});

// The focus pane's two dropdowns have the same problem as the easing one above: their
// options are built from a model list — `tt(\`focusShapes.${shape}\`)` and
// `tt(\`focusTargets.${target}\`)` — so the literal-key checker never sees the keys, and a
// missing name would print the raw key in the Inspector while every check stayed green.
// The lists are spelled out here rather than imported, because they are what the UI offers
// and this test is the place that says so; a new shape or target the pane grows must be
// named here before it can ship.
describe("focus effect names", () => {
	const SHAPES = ["radial", "linear"] as const;
	const TARGETS = ["animation", "fixed"] as const;
	const readTimeline = () =>
		JSON.parse(readFileSync(`${LOCALES_DIR}/${REFERENCE_LOCALE}/timeline.json`, "utf8")) as {
			focusShapes?: Record<string, string>;
			focusTargets?: Record<string, string>;
			screenMotion?: { focus?: Record<string, string> };
		};

	it("has a `timeline.focusShapes` entry for every shape the Inspector offers", () => {
		const { focusShapes } = readTimeline();
		expect(focusShapes).toBeDefined();
		for (const shape of SHAPES) {
			expect(focusShapes?.[shape], `timeline.focusShapes.${shape}`).toBeTruthy();
		}
	});

	it("has a `timeline.focusTargets` entry for every target the Inspector offers", () => {
		const { focusTargets } = readTimeline();
		expect(focusTargets).toBeDefined();
		for (const target of TARGETS) {
			expect(focusTargets?.[target], `timeline.focusTargets.${target}`).toBeTruthy();
		}
	});

	it("has every literal label the focus pane renders", () => {
		const { screenMotion } = readTimeline();
		const labels = screenMotion?.focus;
		expect(labels).toBeDefined();
		for (const key of [
			"title",
			"shape",
			"angle",
			"size",
			"softness",
			"dimming",
			"target",
			"centerX",
			"centerY",
		] as const) {
			expect(labels?.[key], `timeline.screenMotion.focus.${key}`).toBeTruthy();
		}
	});
});
