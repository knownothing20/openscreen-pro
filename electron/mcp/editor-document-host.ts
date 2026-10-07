// The MCP server's door onto the live document, which the editor window owns.
//
// The open project lives in the renderer's store (with the revision that guards
// agent writes), not in the main process, so each MCP call asks the editor for
// a snapshot and hands the result back to the editor's own revision-guarded
// apply — the same `applyAgentDocumentIfCurrent` an in-app chat turn uses.
//
// The editor announces itself on AI_EDITION_MCP_HOST_CHANNEL when it starts
// answering, and again with `false` when it stops; a destroyed window counts as
// stopped. Only that one webContents is ever asked, and only its replies count.

import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainEvent, WebContents } from "electron";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import {
	AI_EDITION_MCP_HOST_CHANNEL,
	AI_EDITION_MCP_REQUEST_CHANNEL,
	AI_EDITION_MCP_RESPONSE_CHANNEL,
	type AiEditionMcpHostRequest,
	type AiEditionMcpHostResponse,
	type AiEditionMcpHostSnapshot,
} from "../../src/native/contracts";
import type { McpApplyResult, McpDocumentHost } from "./openscreen-mcp-server";

// Long enough for a save of a large project to land, short enough that a hung
// renderer does not hold the client's call open indefinitely.
const REQUEST_TIMEOUT_MS = 30_000;

const TIMED_OUT = Symbol("timed-out");

interface Pending {
	resolve: (value: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

type RequestBody =
	| { op: "snapshot" }
	| { op: "apply"; document: unknown; expectedRevision: number };

export class EditorDocumentHost implements McpDocumentHost {
	private editor: WebContents | null = null;
	private readonly pending = new Map<string, Pending>();

	constructor(ipcMain: IpcMain) {
		ipcMain.on(AI_EDITION_MCP_HOST_CHANNEL, (event: IpcMainEvent, active: unknown) => {
			if (active === true) {
				this.editor = event.sender;
				event.sender.once("destroyed", () => {
					if (this.editor === event.sender) this.editor = null;
				});
			} else if (this.editor === event.sender) {
				this.editor = null;
			}
		});
		ipcMain.on(AI_EDITION_MCP_RESPONSE_CHANNEL, (event: IpcMainEvent, message: unknown) => {
			if (event.sender !== this.editor) return;
			const response = message as AiEditionMcpHostResponse | null;
			if (!response || typeof response.requestId !== "string") return;
			const pending = this.pending.get(response.requestId);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.pending.delete(response.requestId);
			pending.resolve(response.result);
		});
	}

	private request(body: RequestBody): Promise<unknown> {
		const editor = this.editor;
		if (!editor || editor.isDestroyed()) return Promise.resolve(undefined);
		const requestId = randomUUID();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				resolve(TIMED_OUT);
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(requestId, { resolve, timer });
			try {
				editor.send(AI_EDITION_MCP_REQUEST_CHANNEL, {
					requestId,
					...body,
				} satisfies AiEditionMcpHostRequest);
			} catch {
				clearTimeout(timer);
				this.pending.delete(requestId);
				resolve(undefined);
			}
		});
	}

	async snapshot(): Promise<AiEditionMcpHostSnapshot | null> {
		const result = await this.request({ op: "snapshot" });
		if (!result || result === TIMED_OUT || typeof result !== "object") return null;
		// The revision is the apply guard: one that is missing or not a number would
		// reach `applyAgentDocumentIfCurrent` as `undefined`, which skips the
		// stale-edit check entirely. Treat such a reply as no snapshot at all.
		const snapshot = result as Partial<AiEditionMcpHostSnapshot>;
		if (typeof snapshot.revision !== "number" || !Number.isFinite(snapshot.revision)) return null;
		return snapshot as AiEditionMcpHostSnapshot;
	}

	async apply(document: AxcutDocument, expectedRevision: number): Promise<McpApplyResult> {
		const result = await this.request({ op: "apply", document, expectedRevision });
		if (result === TIMED_OUT) return "timeout";
		if (typeof result !== "string") return "no-editor";
		return result as McpApplyResult;
	}
}
