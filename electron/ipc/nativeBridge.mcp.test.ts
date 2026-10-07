// The MCP settings actions take renderer input, so the bridge checks its types
// before anything reaches the settings store: a bad value is an INVALID_REQUEST,
// not an INTERNAL_ERROR thrown further in.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeBridgeResponse } from "../../src/native/contracts";
import { type NativeBridgeContext, registerNativeBridgeHandlers } from "./nativeBridge";

const electron = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("electron", () => ({
	app: { getAppPath: () => "", isPackaged: false },
	ipcMain: { handle: electron.handle, removeHandler: vi.fn() },
	shell: {},
}));
vi.mock("../native-bridge/services/compositorViewService", () => ({
	CompositorViewService: class {},
}));

const service = vi.hoisted(() => ({
	mcpSetEnabled: vi.fn(async () => ({ ok: "enabled" })),
	mcpSetPort: vi.fn(async () => ({ ok: "port" })),
	mcpSetAllowEdits: vi.fn(async () => ({ ok: "allowEdits" })),
}));
vi.mock("../native-bridge/services/aiEditionService", () => ({
	AiEditionService: class {
		mcpSetEnabled = service.mcpSetEnabled;
		mcpSetPort = service.mcpSetPort;
		mcpSetAllowEdits = service.mcpSetAllowEdits;
	},
}));

let invoke: (action: string, payload: unknown) => Promise<NativeBridgeResponse>;

beforeEach(() => {
	electron.handle.mockClear();
	for (const fn of Object.values(service)) fn.mockClear();
	registerNativeBridgeHandlers({
		getPlatform: () => "linux",
		getAiEditionDocuments: () => ({}),
		getAiEditionLlmConfig: () => ({}),
	} as unknown as NativeBridgeContext);
	const handler = electron.handle.mock.calls[0]?.[1] as (
		event: unknown,
		request: unknown,
	) => Promise<NativeBridgeResponse>;
	invoke = (action, payload) =>
		handler({ sender: {} }, { domain: "aiEdition", action, payload, requestId: "r" });
});

function errorCode(response: NativeBridgeResponse): string | undefined {
	return response.ok ? undefined : response.error?.code;
}

describe("native bridge MCP settings", () => {
	it.each([80, 70000, 4.5, "47821", null])("rejects port %s as a bad request", async (port) => {
		expect(errorCode(await invoke("mcp.setPort", { port }))).toBe("INVALID_REQUEST");
		expect(service.mcpSetPort).not.toHaveBeenCalled();
	});

	it("passes a valid port on", async () => {
		const response = await invoke("mcp.setPort", { port: 47821 });
		expect(response.ok).toBe(true);
		expect(service.mcpSetPort).toHaveBeenCalledWith(47821);
	});

	it.each(["true", 1, undefined])("rejects enabled=%s as a bad request", async (enabled) => {
		expect(errorCode(await invoke("mcp.setEnabled", { enabled }))).toBe("INVALID_REQUEST");
		expect(service.mcpSetEnabled).not.toHaveBeenCalled();
	});

	it.each(["yes", 0, undefined])("rejects allowEdits=%s as a bad request", async (allowEdits) => {
		expect(errorCode(await invoke("mcp.setAllowEdits", { allowEdits }))).toBe("INVALID_REQUEST");
		expect(service.mcpSetAllowEdits).not.toHaveBeenCalled();
	});

	it("passes valid flags on", async () => {
		await invoke("mcp.setEnabled", { enabled: true });
		await invoke("mcp.setAllowEdits", { allowEdits: false });
		expect(service.mcpSetEnabled).toHaveBeenCalledWith(true);
		expect(service.mcpSetAllowEdits).toHaveBeenCalledWith(false);
	});
});
