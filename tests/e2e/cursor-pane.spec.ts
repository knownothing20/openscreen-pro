// The Cursor pane is gated on `useHasRecordedCursor()`, which asks the native bridge whether the
// take has a sidecar — a question a plain page cannot answer. The shim's cursor fixture (see
// `readCursorFixture` in src/native/browserShim.ts) is what makes the pane reachable here, so
// these two tests are also the proof that the fixture channel is wired the way the pane expects.
//
// Browser mode only: passing here says nothing about the real native reader, which is covered by
// the manual pass, not by this file.
import { expect, type Page, test } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const EDITOR_URL = `${BASE_URL}/?windowType=editor`;

const TITLE = "Cursor pane fixture";

function makeDoc() {
	return {
		schemaVersion: 5,
		project: {
			id: "proj_cursor_pane",
			title: TITLE,
			createdAt: "2026-07-01T00:00:00.000Z",
			updatedAt: "2026-07-01T00:00:00.000Z",
			primaryAssetId: "asset_main",
		},
		assets: [
			{
				id: "asset_main",
				kind: "video",
				label: "take.mp4",
				originalPath: "C:\\fixtures\\take.mp4",
				durationSec: 4,
				sizeBytes: 120000,
				video: { codec: "h264", width: 1920, height: 1080, fps: 60 },
				cameraTrack: null,
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [
				{
					id: "clip_main",
					assetId: "asset_main",
					sourceStartSec: 0,
					sourceEndSec: 4,
					timelineStartSec: 0,
					timelineEndSec: 4,
					wordRefs: [],
					origin: "system",
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: { cursorClickBounce: 1 },
		agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
		preview: { strategy: "seek", revision: 0 },
		export: { preset: "final-balanced", lastJobId: null },
		history: { revisions: [] },
	};
}

const CURSOR_FIXTURE = {
	default: {
		version: 3,
		provider: "native",
		assets: [],
		samples: [
			// Two different cursor shapes: the editor decides "this take has cursor data" from the
			// state changes it can name, not from the sample count.
			{ timeMs: 0, cx: 0.5, cy: 0.5, visible: true, cursorType: "arrow", interactionType: "move" },
			{
				timeMs: 1000,
				cx: 0.5,
				cy: 0.5,
				visible: true,
				cursorType: "pointer",
				interactionType: "click",
			},
		],
	},
};

async function seedAndOpen(page: Page, withCursor: boolean): Promise<void> {
	const doc = makeDoc();
	await page.addInitScript(
		({ serialized, cursor }) => {
			const parsed = JSON.parse(serialized);
			localStorage.setItem(
				"browser-shim-projects-v2",
				JSON.stringify({ documents: { [parsed.project.id]: parsed }, order: [parsed.project.id] }),
			);
			if (cursor) localStorage.setItem("browser-shim-cursor-v1", JSON.stringify(cursor));
		},
		{ serialized: JSON.stringify(doc), cursor: withCursor ? CURSOR_FIXTURE : null },
	);

	await page.goto(EDITOR_URL, { waitUntil: "domcontentloaded" });
	const picker = page.getByRole("dialog");
	// The shortcut only lands once the shell has mounted; retry instead of sleeping.
	await expect(async () => {
		await page.keyboard.press("Control+o");
		await expect(picker).toBeVisible({ timeout: 1_500 });
	}).toPass({ timeout: 15_000 });
	await picker.getByRole("button", { name: new RegExp(`^${TITLE}`) }).click();
	await expect(page.locator("[data-clip-id]")).toHaveCount(1, { timeout: 15_000 });
}

test.describe("cursor pane", () => {
	test("the facet appears when the take carries cursor data", async ({ page }) => {
		await seedAndOpen(page, true);

		const facet = page.getByRole("button", { name: "Cursor", exact: true });
		await expect(facet).toBeVisible();
		await facet.click();

		// The pane's own controls, not just the tab: this is the surface the V2.7.2 settings live on.
		// Toggles are `button[aria-pressed]` with the setting name as their label (RightPanes.Toggle).
		await expect(page.getByRole("button", { name: "Mouse trail" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Cursor halo" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Dot", exact: true })).toBeVisible();
	});

	test("the facet stays hidden when the take has no sidecar", async ({ page }) => {
		await seedAndOpen(page, false);
		// A take recorded with the system cursor baked in has no sidecar, and every cursor setting
		// would change nothing — so the editor leaves the facet out rather than showing dead controls.
		// Same locator as the positive case, so "no facet" cannot pass because of a wrong role.
		await expect(page.getByRole("button", { name: "Cursor", exact: true })).toHaveCount(0);
	});
});
