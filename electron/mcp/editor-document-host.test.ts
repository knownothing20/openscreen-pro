import { EventEmitter } from "node:events";
import type { IpcMain, WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import {
	AI_EDITION_MCP_HOST_CHANNEL,
	AI_EDITION_MCP_REQUEST_CHANNEL,
	AI_EDITION_MCP_RESPONSE_CHANNEL,
	type AiEditionMcpHostRequest,
} from "../../src/native/contracts";
import { EditorDocumentHost } from "./editor-document-host";

/** A webContents that records what main sends it and can be destroyed. */
class FakeWebContents extends EventEmitter {
	sent: AiEditionMcpHostRequest[] = [];
	destroyed = false;
	send(channel: string, payload: AiEditionMcpHostRequest) {
		if (channel === AI_EDITION_MCP_REQUEST_CHANNEL) this.sent.push(payload);
	}
	isDestroyed() {
		return this.destroyed;
	}
	destroy() {
		this.destroyed = true;
		this.emit("destroyed");
	}
}

function setup() {
	const ipc = new EventEmitter();
	const host = new EditorDocumentHost(ipc as unknown as IpcMain);
	const fromRenderer = (sender: FakeWebContents, channel: string, payload: unknown) =>
		ipc.emit(channel, { sender: sender as unknown as WebContents }, payload);
	return { host, fromRenderer };
}

/** Answers the next request the editor receives. */
async function answer(
	editor: FakeWebContents,
	fromRenderer: ReturnType<typeof setup>["fromRenderer"],
	result: unknown,
	sender = editor,
) {
	await vi.waitFor(() => expect(editor.sent.length).toBeGreaterThan(0));
	const request = editor.sent.shift();
	fromRenderer(sender, AI_EDITION_MCP_RESPONSE_CHANNEL, { requestId: request?.requestId, result });
}

afterEach(() => {
	vi.useRealTimers();
});

describe("EditorDocumentHost", () => {
	it("answers null while no editor has registered", async () => {
		const { host } = setup();
		await expect(host.snapshot()).resolves.toBeNull();
	});

	it("asks the registered editor for its snapshot", async () => {
		const { host, fromRenderer } = setup();
		const editor = new FakeWebContents();
		fromRenderer(editor, AI_EDITION_MCP_HOST_CHANNEL, true);
		const pending = host.snapshot();
		await answer(editor, fromRenderer, { document: { id: "d" }, revision: 3 });
		await expect(pending).resolves.toEqual({ document: { id: "d" }, revision: 3 });
	});

	it("treats a snapshot without a numeric revision as no snapshot", async () => {
		const { host, fromRenderer } = setup();
		const editor = new FakeWebContents();
		fromRenderer(editor, AI_EDITION_MCP_HOST_CHANNEL, true);
		// A missing revision would reach the apply guard as `undefined` and skip it.
		for (const revision of [undefined, "3", Number.NaN]) {
			const pending = host.snapshot();
			await answer(editor, fromRenderer, { document: { id: "d" }, revision });
			await expect(pending).resolves.toBeNull();
		}
	});

	it("passes the apply verdict through", async () => {
		const { host, fromRenderer } = setup();
		const editor = new FakeWebContents();
		fromRenderer(editor, AI_EDITION_MCP_HOST_CHANNEL, true);
		const document = createEmptyDocument({ projectId: "p", title: "t" });
		const pending = host.apply(document, 7);
		await vi.waitFor(() => expect(editor.sent).toHaveLength(1));
		expect(editor.sent[0]).toMatchObject({ op: "apply", expectedRevision: 7 });
		await answer(editor, fromRenderer, "conflict");
		await expect(pending).resolves.toBe("conflict");
	});

	it("ignores a reply from any other window", async () => {
		vi.useFakeTimers();
		const { host, fromRenderer } = setup();
		const editor = new FakeWebContents();
		fromRenderer(editor, AI_EDITION_MCP_HOST_CHANNEL, true);
		const pending = host.snapshot();
		await answer(editor, fromRenderer, { document: {}, revision: 1 }, new FakeWebContents());
		await vi.advanceTimersByTimeAsync(30_000);
		await expect(pending).resolves.toBeNull();
	});

	it("forgets an editor that unregisters or is destroyed", async () => {
		const { host, fromRenderer } = setup();
		const first = new FakeWebContents();
		fromRenderer(first, AI_EDITION_MCP_HOST_CHANNEL, true);
		fromRenderer(first, AI_EDITION_MCP_HOST_CHANNEL, false);
		await expect(host.snapshot()).resolves.toBeNull();

		const second = new FakeWebContents();
		fromRenderer(second, AI_EDITION_MCP_HOST_CHANNEL, true);
		second.destroy();
		await expect(host.snapshot()).resolves.toBeNull();
		expect(second.sent).toHaveLength(0);
	});

	it("reports an unanswered apply as a timeout, not as a failure", async () => {
		vi.useFakeTimers();
		const { host, fromRenderer } = setup();
		const editor = new FakeWebContents();
		fromRenderer(editor, AI_EDITION_MCP_HOST_CHANNEL, true);
		const pending = host.apply(createEmptyDocument({ projectId: "p", title: "t" }), 1);
		await vi.advanceTimersByTimeAsync(30_000);
		await expect(pending).resolves.toBe("timeout");
	});
});
