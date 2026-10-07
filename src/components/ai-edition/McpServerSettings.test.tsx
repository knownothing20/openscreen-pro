// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AiEditionMcpStatus } from "@/native/contracts";

const TOKEN = "secret-token";
const URL = "http://127.0.0.1:47821/mcp";

function status(enabled: boolean, allowEdits = false): AiEditionMcpStatus {
	return {
		enabled,
		port: 47821,
		allowEdits,
		running: enabled,
		url: URL,
		token: enabled ? TOKEN : null,
		error: null,
	};
}

const bridge = vi.hoisted(() => ({
	mcpGetStatus: vi.fn(),
	mcpSetEnabled: vi.fn(),
	mcpSetPort: vi.fn(),
	mcpSetAllowEdits: vi.fn(),
	mcpRegenerateToken: vi.fn(),
}));

vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: bridge } }));

import { claudeCodeCommand, codexCommand, McpServerSettings } from "./McpServerSettings";

const copyToClipboard = vi.fn(() => Promise.resolve());

function renderSection() {
	return render(
		<I18nProvider>
			<McpServerSettings open />
		</I18nProvider>,
	);
}

describe("McpServerSettings", () => {
	beforeEach(() => {
		for (const fn of Object.values(bridge)) fn.mockReset();
		copyToClipboard.mockClear();
		(window as unknown as { electronAPI: unknown }).electronAPI = { copyToClipboard };
	});
	afterEach(cleanup);

	it("shows the server as off, with no token or commands", async () => {
		bridge.mcpGetStatus.mockResolvedValue(status(false));
		renderSection();
		expect(await screen.findByTestId("mcp-server-settings")).toBeInTheDocument();
		expect(screen.getByTestId("mcp-server-toggle")).toHaveAttribute("aria-pressed", "false");
		expect(screen.queryByText(/claude mcp add/)).not.toBeInTheDocument();
	});

	it("turns the server on and shows how to connect, token masked", async () => {
		bridge.mcpGetStatus.mockResolvedValue(status(false));
		bridge.mcpSetEnabled.mockResolvedValue(status(true));
		renderSection();
		fireEvent.click(await screen.findByTestId("mcp-server-toggle"));
		await waitFor(() => expect(bridge.mcpSetEnabled).toHaveBeenCalledWith(true));
		expect(await screen.findByText(codexCommand(URL))).toBeInTheDocument();
		expect(screen.queryByText(new RegExp(TOKEN))).not.toBeInTheDocument();
	});

	it("keeps MCP edits off until they are turned on", async () => {
		bridge.mcpGetStatus.mockResolvedValue(status(true));
		bridge.mcpSetAllowEdits.mockResolvedValue(status(true, true));
		renderSection();
		const toggle = await screen.findByTestId("mcp-edits-toggle");
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(toggle);
		await waitFor(() => expect(bridge.mcpSetAllowEdits).toHaveBeenCalledWith(true));
		await waitFor(() =>
			expect(screen.getByTestId("mcp-edits-toggle")).toHaveAttribute("aria-pressed", "true"),
		);
	});

	it("copies the real token into the Claude Code command", async () => {
		bridge.mcpGetStatus.mockResolvedValue(status(true));
		renderSection();
		await screen.findByText(codexCommand(URL));
		const copyButtons = screen.getAllByRole("button", { name: "Copy" });
		// Token, Claude Code, Codex — in that order.
		fireEvent.click(copyButtons[1]);
		expect(copyToClipboard).toHaveBeenCalledWith(claudeCodeCommand(URL, TOKEN));
	});

	it("stays out of the way when the status cannot be read", async () => {
		bridge.mcpGetStatus.mockImplementation(() => {
			throw new Error("no bridge");
		});
		renderSection();
		await waitFor(() => expect(bridge.mcpGetStatus).toHaveBeenCalled());
		expect(screen.queryByTestId("mcp-server-settings")).not.toBeInTheDocument();
	});
});
