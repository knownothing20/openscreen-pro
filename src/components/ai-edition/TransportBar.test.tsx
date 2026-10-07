// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/contexts/I18nContext";
import { ShortcutsProvider } from "@/contexts/ShortcutsContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { TransportBar } from "./TransportBar";

vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: {} },
}));

class StubResizeObserver {
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
}

function providers(children: ReactNode) {
	return (
		<I18nProvider>
			<ShortcutsProvider>
				<TooltipProvider>{children}</TooltipProvider>
			</ShortcutsProvider>
		</I18nProvider>
	);
}

const clips = [
	{
		id: "clip_a",
		assetId: "asset_1",
		sourceStartSec: 0,
		sourceEndSec: 30,
		timelineStartSec: 0,
		timelineEndSec: 30,
		wordRefs: [],
		origin: "user" as const,
		reason: "",
	},
];

const noop = vi.fn();

describe("TransportBar reads the playhead from the store", () => {
	beforeEach(() => {
		useProjectStore.setState({ currentTimeSec: 0 });
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	// The counterpart to useTimeline.test.ts's "not re-rendered by playhead ticks":
	// now that the editor shell no longer subscribes to the playhead, the pieces that
	// DO display it have to pick it up themselves. Nothing here re-renders the parent
	// — the store write alone must move the timecode.
	it("updates the timecode on a store write, with no parent re-render", () => {
		let parentRenders = 0;
		function Parent() {
			parentRenders++;
			return (
				<TransportBar playing={false} overrideTimeSec={null} clips={clips} onTogglePlay={noop} />
			);
		}

		render(providers(<Parent />));
		const rendersAfterMount = parentRenders;
		expect(screen.getByText("0:00.0")).toBeInTheDocument();

		act(() => {
			useProjectStore.getState().setCurrentTime(12.3);
		});

		expect(screen.getByText("0:12.3")).toBeInTheDocument();
		expect(parentRenders).toBe(rendersAfterMount);
	});

	// A timeline scrub drag writes the store on a rAF, so for the frame in between the
	// pointer position is only in `overrideTimeSec` — it has to win over the store.
	it("prefers the live scrub override over the store value", () => {
		useProjectStore.setState({ currentTimeSec: 12.3 });
		render(
			providers(
				<TransportBar playing={false} overrideTimeSec={4.5} clips={clips} onTogglePlay={noop} />,
			),
		);
		expect(screen.getByText("0:04.5")).toBeInTheDocument();
	});
});

describe("TransportBar play button", () => {
	beforeEach(() => {
		vi.stubGlobal("ResizeObserver", StubResizeObserver);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
	});

	function renderTransport(playing: boolean) {
		render(
			providers(
				<TransportBar playing={playing} overrideTimeSec={null} clips={clips} onTogglePlay={noop} />,
			),
		);
	}

	// Opens the tooltip the way the keyboard does, without the hover delay.
	async function openTooltip(button: HTMLElement) {
		act(() => button.focus());
		await screen.findByRole("tooltip");
		return document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
	}

	// The icon swaps, so the name swaps with it. It is an action, not a toggle: no aria-pressed.
	it("is named for what pressing it does, and swaps with the icon", () => {
		renderTransport(false);
		const play = screen.getByRole("button", { name: "Play" });
		expect(play).not.toHaveAttribute("aria-pressed");
		expect(play).not.toHaveAttribute("title");

		cleanup();
		renderTransport(true);
		expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
	});

	it("shows the default binding as a chip, not as text in the name", async () => {
		renderTransport(false);
		const tooltip = await openTooltip(screen.getByRole("button", { name: "Play" }));
		expect(tooltip?.querySelector("kbd")).toHaveTextContent("Space");
		expect(tooltip?.querySelector("kbd")?.previousSibling?.textContent).toBe("Play");
	});

	// Play/Pause is remappable, so a key written into the string would lie after the remap.
	it("shows the binding the user chose", async () => {
		const getShortcuts = vi.fn(async () => ({ playPause: { key: "k" } }));
		(window as unknown as { electronAPI?: unknown }).electronAPI = { getShortcuts };
		renderTransport(true);
		await waitFor(() => expect(getShortcuts).toHaveBeenCalled());
		// Let the saved bindings land in the provider.
		await act(() => Promise.resolve());
		const tooltip = await openTooltip(screen.getByRole("button", { name: "Pause" }));
		expect(tooltip?.querySelector("kbd")).toHaveTextContent("K");
		expect(tooltip?.querySelector("kbd")).not.toHaveTextContent("Space");
	});
});
