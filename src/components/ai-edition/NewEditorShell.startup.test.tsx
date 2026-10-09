// @vitest-environment jsdom
// What the editor does when it mounts.
//
// It imports a recording that is waiting to be opened — the recorder handing the editor
// its own output — and does NOTHING else. It used to fall back to opening the most recent
// project, which dropped the user into a project they had not chosen. The empty state
// offers Load Project, record and import, so the choice belongs to the user.
//
// Both halves are pinned here, because the fix is only correct if it keeps the other one:
// removing the auto-open must not also remove the recorder's hand-off.

import "@testing-library/jest-dom";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const importPendingRecording = vi.hoisted(() => vi.fn());

vi.mock("./recordingImport", () => ({
	importPendingRecording,
	maybeSaveFreshRecordingAutoZooms: () => Promise.resolve(false),
}));

vi.mock("@/contexts/ShortcutsContext", async () => {
	const { DEFAULT_SHORTCUTS } = await import("@/lib/shortcuts");
	return {
		useShortcuts: () => ({
			shortcuts: DEFAULT_SHORTCUTS,
			isMac: false,
			isConfigOpen: false,
			openConfig: () => {
				/* not exercised here */
			},
			closeConfig: () => {
				/* not exercised here */
			},
			setShortcuts: () => {
				/* not exercised here */
			},
			persistShortcuts: () => Promise.resolve(true),
		}),
	};
});

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({
		locale: "en",
		setLocale: () => {
			/* fixed locale */
		},
	}),
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const bridgeMocks = vi.hoisted(() => ({
	listProjects: vi.fn(),
	loadProject: vi.fn(),
	save: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			listProjects: bridgeMocks.listProjects,
			get: bridgeMocks.loadProject,
			save: bridgeMocks.save,
		},
	},
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { NewEditorShell } from "./NewEditorShell";

function renderShell() {
	return render(
		<TooltipProvider>
			<EditorDialogsProvider>
				<NewEditorShell />
			</EditorDialogsProvider>
		</TooltipProvider>,
	);
}

beforeEach(() => {
	importPendingRecording.mockReset();
	importPendingRecording.mockResolvedValue(false);
	for (const mock of Object.values(bridgeMocks)) mock.mockReset();
	useProjectStore.getState().clear();

	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		onAiEditionChatEvent: () => () => {
			/* unsubscribe */
		},
		setTitleBarOverlay: () => {
			/* no native titlebar */
		},
		setHasUnsavedChanges: () => {
			/* no window close guard */
		},
		onRequestCloseConfirm: () => () => {
			/* unsubscribe */
		},
		onRequestSaveBeforeClose: () => () => {
			/* unsubscribe */
		},
		sendCloseConfirmResponse: () => {
			/* nothing is closing this window */
		},
		findRecordingCamera: () => Promise.resolve(null),
		preparePreviewAudioTrack: () => Promise.resolve({ success: false, path: null }),
	};
	Element.prototype.scrollTo = () => {
		/* no scrolling in jsdom */
	};
	(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = class {
		observe() {
			/* never fires: nothing has a layout in jsdom */
		}
		unobserve() {
			/* see observe */
		}
		disconnect() {
			/* see observe */
		}
	};
});

afterEach(() => {
	cleanup();
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
	useProjectStore.getState().clear();
});

describe("NewEditorShell on mount", () => {
	it("leaves the editor empty instead of opening the most recent project", async () => {
		// A project is there to be found — the old code would have opened it.
		bridgeMocks.listProjects.mockResolvedValue([
			{ id: "proj_recent", title: "Recent", updatedAt: "2026-10-08T00:00:00.000Z" },
		]);

		await act(async () => {
			renderShell();
		});

		// Nothing was opened: the user picks from the empty state.
		expect(useProjectStore.getState().document).toBeNull();
		expect(useProjectStore.getState().projectId).toBeNull();
	});

	it("still imports a recording that is waiting to be opened", async () => {
		importPendingRecording.mockResolvedValue(true);

		await act(async () => {
			renderShell();
		});

		expect(importPendingRecording).toHaveBeenCalledTimes(1);
	});
});
