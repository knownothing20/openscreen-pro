// The OpenScreen MCP server: the in-app agent's tools, offered to any MCP client
// (Claude Code, Codex, Cursor…) that the user runs themselves.
//
// Nothing here is a second implementation. The tool list, argument schemas,
// descriptions and guidance are the in-app agent's own (`TOOL_ARG_SCHEMAS`,
// `TOOL_DESCRIPTIONS`, `buildSystemPrompt`), and every call runs through
// `runDocumentTool` — the same executor, consent gate and cursor read the
// in-app agent uses. The one difference is where the document comes from: the
// in-app agent is handed a snapshot per chat turn, while here each call reads
// the live document from the editor window and writes the result back through
// the same revision-guarded apply, so a user edit landing mid-call is never
// overwritten and every edit is one undo step.
//
// The HTTP layer is local-only: bound to 127.0.0.1, a bearer token on every
// request, and a Host/Origin check so a web page cannot reach it by DNS
// rebinding.

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type AxcutDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import { isMutatingTool } from "../ai-edition/agent-tools";
import {
	buildSystemPrompt,
	type CursorTelemetryReader,
	probeCursorTelemetry,
	runDocumentTool,
	TOOL_ARG_SCHEMAS,
	TOOL_DESCRIPTIONS,
} from "../ai-edition/deep-agent/service";

export const MCP_SERVER_NAME = "openscreen";
export const MCP_ENDPOINT_PATH = "/mcp";

export interface McpDocumentSnapshot {
	document: unknown;
	/** The editor's revision when the snapshot was taken — the apply guard. */
	revision: number;
}

/** Mirrors the renderer's `AgentDocumentApplyResult`, plus the editor having gone
 *  away or not answering in time. */
export type McpApplyResult =
	| "applied"
	| "conflict"
	| "save-failed"
	| "no-live-document"
	| "no-editor"
	| "timeout";

/** The live document, as held by the editor window. */
export interface McpDocumentHost {
	/** `null` when no editor window is open or it has no project loaded. */
	snapshot(): Promise<McpDocumentSnapshot | null>;
	apply(document: AxcutDocument, expectedRevision: number): Promise<McpApplyResult>;
}

export interface McpToolDeps {
	host: McpDocumentHost;
	/** The "Project edits" setting — the same one the in-app agent obeys. */
	editsAllowed(): boolean;
	cursor?: CursorTelemetryReader;
	version: string;
}

const NO_PROJECT_MESSAGE =
	"No project is open in the OpenScreen editor. Ask the user to open one in OpenScreen, then retry.";

const APPLY_FAILURE_MESSAGES: Record<Exclude<McpApplyResult, "applied">, string> = {
	conflict:
		"The edit was NOT applied: the project changed in the editor while this call ran. Call getCurrentDocument to re-read it, then retry.",
	"save-failed": "The edit was NOT applied: OpenScreen could not save the project.",
	"no-live-document": NO_PROJECT_MESSAGE,
	"no-editor": NO_PROJECT_MESSAGE,
	// Not "NOT applied": the editor may have saved it and only the answer was lost.
	timeout:
		"OpenScreen did not confirm this edit in time. Call getCurrentDocument to see whether it landed before retrying.",
};

const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
	"replaceTimeline",
	"removeTrim",
	"removeModifier",
	"removeClip",
]);

const MCP_PREAMBLE = [
	"These tools act on the project currently open in the OpenScreen editor. Every edit is saved straight away and appears in the editor, where the user can undo it with Ctrl/Cmd+Z. Nothing here records, exports or imports media.",
	"",
].join("\n");

function textResult(text: string, isError: boolean): CallToolResult {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Runs tool calls one at a time. Each call is snapshot → execute → apply, and
 * two of those interleaving would make the second apply against a revision the
 * first just moved — a spurious conflict at best.
 */
export function createToolRunner(deps: McpToolDeps) {
	let queue: Promise<unknown> = Promise.resolve();

	async function run(name: string, args: unknown): Promise<CallToolResult> {
		const snapshot = await deps.host.snapshot();
		if (!snapshot) return textResult(NO_PROJECT_MESSAGE, true);
		const parsed = documentSchema.safeParse(snapshot.document);
		if (!parsed.success) {
			return textResult("The project open in the editor could not be read.", true);
		}
		const document = parsed.data;
		const availableByAssetId = await probeCursorTelemetry(document, deps.cursor);
		const execution = await runDocumentTool(document, name, args, deps.editsAllowed(), {
			cursor: deps.cursor,
			availableByAssetId,
		});
		if (execution.document) {
			const applied = await deps.host.apply(execution.document, snapshot.revision);
			if (applied !== "applied") return textResult(APPLY_FAILURE_MESSAGES[applied], true);
		}
		return textResult(execution.resultJson, !execution.ok);
	}

	return (name: string, args: unknown): Promise<CallToolResult> => {
		const next = queue.then(
			() => run(name, args),
			() => run(name, args),
		);
		queue = next.catch(() => undefined);
		return next.catch((error) => textResult(`Tool failed: ${errorMessage(error)}`, true));
	};
}

export function createOpenScreenMcpServer(
	deps: McpToolDeps,
	runTool: (name: string, args: unknown) => Promise<CallToolResult>,
): McpServer {
	const server = new McpServer(
		{ name: MCP_SERVER_NAME, version: deps.version },
		{ instructions: MCP_PREAMBLE + buildSystemPrompt({ editsAllowed: deps.editsAllowed() }) },
	);
	for (const [name, schema] of TOOL_ARG_SCHEMAS) {
		const mutating = isMutatingTool(name);
		server.registerTool(
			name,
			{
				description: TOOL_DESCRIPTIONS[name],
				inputSchema: schema,
				annotations: {
					readOnlyHint: !mutating,
					destructiveHint: DESTRUCTIVE_TOOLS.has(name),
					openWorldHint: false,
				},
			},
			(args: unknown) => runTool(name, args),
		);
	}
	return server;
}

function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
	return hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`;
}

function isAllowedOrigin(origin: string | undefined, port: number): boolean {
	// MCP clients are not browsers and send no Origin; a browser always does.
	if (origin === undefined) return true;
	return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function hasValidToken(authorization: string | undefined, token: string): boolean {
	const presented = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
	const a = Buffer.from(presented);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

function reject(res: ServerResponse, status: number, message: string, headers = {}): void {
	res.writeHead(status, { "Content-Type": "application/json", ...headers });
	res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export interface RunningMcpServer {
	port: number;
	close(): Promise<void>;
}

export async function startMcpHttpServer(options: {
	port: number;
	token: string;
	deps: McpToolDeps;
}): Promise<RunningMcpServer> {
	const { token, deps } = options;
	const runTool = createToolRunner(deps);
	let boundPort = options.port;

	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		if (pathname !== MCP_ENDPOINT_PATH) return reject(res, 404, "Not found");
		if (!isAllowedHost(req.headers.host, boundPort)) return reject(res, 403, "Forbidden host");
		if (!isAllowedOrigin(req.headers.origin, boundPort)) {
			return reject(res, 403, "Forbidden origin");
		}
		if (!hasValidToken(req.headers.authorization, token)) {
			return reject(res, 401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
		}

		// Stateless: one server + transport per request, the SDK's documented shape
		// for a server that keeps no per-session state. Tools read the live editor
		// on every call, so there is nothing a session would need to remember.
		const server = createOpenScreenMcpServer(deps, runTool);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		res.on("close", () => {
			void transport.close();
			void server.close();
		});
		try {
			await server.connect(transport);
			await transport.handleRequest(req, res);
		} catch (error) {
			if (!res.headersSent) reject(res, 500, errorMessage(error));
		}
	};

	const httpServer: Server = createServer((req, res) => {
		void handle(req, res);
	});
	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(options.port, "127.0.0.1", () => {
			httpServer.off("error", reject);
			resolve();
		});
	});
	boundPort = (httpServer.address() as AddressInfo).port;

	return {
		port: boundPort,
		close: () =>
			new Promise<void>((resolve) => {
				httpServer.closeAllConnections();
				httpServer.close(() => resolve());
			}),
	};
}
