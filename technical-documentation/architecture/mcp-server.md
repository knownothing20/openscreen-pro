# MCP server

OpenScreen can offer the in-app agent's tools to MCP clients the user runs themselves — Claude Code, Codex, Cursor, anything that speaks MCP over Streamable HTTP. The client brings its own model and its own sign-in; OpenScreen never sees, stores or relays those credentials. It is off by default and turned on in **Settings → AI → MCP server**.

| File | Role |
|---|---|
| [`electron/mcp/openscreen-mcp-server.ts`](../../electron/mcp/openscreen-mcp-server.ts) | The MCP server and its local HTTP guard. Registers the tools, runs each call. |
| [`electron/mcp/editor-document-host.ts`](../../electron/mcp/editor-document-host.ts) | Main-process side of the live document: asks the editor window for a snapshot and hands edits back. |
| [`electron/mcp/mcp-controller.ts`](../../electron/mcp/mcp-controller.ts) | Lifecycle: start when enabled, restart on a port or token change, status for the settings UI. |
| [`electron/mcp/mcp-settings-store.ts`](../../electron/mcp/mcp-settings-store.ts) | `mcp-server.json` (enabled, port, allowEdits) and `mcp-token.enc` (bearer token, `safeStorage`). |
| [`src/lib/ai-edition/store/mcpDocumentHost.ts`](../../src/lib/ai-edition/store/mcpDocumentHost.ts) | Renderer side: answers snapshot / apply requests from the project store. Mounted by `NewEditorShell`. |
| [`src/components/ai-edition/McpServerSettings.tsx`](../../src/components/ai-edition/McpServerSettings.tsx) | The settings section: server toggle, its own Project edits toggle, port, token, copyable `claude mcp add` / `codex mcp add` commands. |

## One tool surface, two agents

Nothing about the tools is reimplemented. The server registers `TOOL_ARG_SCHEMAS` (names and zod schemas), `TOOL_DESCRIPTIONS`, and hands `buildSystemPrompt` to the client as the server `instructions` — all exported from [`deep-agent/service.ts`](../../electron/ai-edition/deep-agent/service.ts), where `buildTools` builds the in-app agent from the same table. Every call goes through `runDocumentTool`, the function the in-app agent's `documentTool` also calls: the cursor-telemetry read the zoom tools need, then `executeAgentTool`.

So a tool added to the agent appears over MCP with no further work, and the MCP test asserts the listed tools equal `OPENSCREEN_TOOL_NAMES`. What the server adds is MCP metadata only: `readOnlyHint` for the reads (`!isMutatingTool`) and `destructiveHint` for `replaceTimeline` and the three `remove*` tools.

**Writes are a second opt-in.** MCP clients have their own "Project edits" switch, `allowEdits` in `mcp-server.json`, **off by default** and independent of the in-app agent's `allowAgentEdits`. Turning the server on therefore grants read access only. The value is read on every call and passed to the executor as `editsAllowed`, the same gate the in-app agent's switch drives: while it is off every mutating tool is refused with the executor's consent message, and the consent block of the system prompt is in the instructions. It is independent because `allowAgentEdits` defaults to allowed and lives in the provider form, so a user with no provider configured could never have turned MCP writes off.

## Where the document comes from

The in-app agent is handed a document snapshot per chat turn. An MCP client has no turn, so each call reads the **live** document from the editor window, which owns it (`useProjectStore`, with its `revision`):

1. `EditorDocumentHost.snapshot()` sends `{op: "snapshot"}` on `ai-edition.mcp-request` to the editor; it answers `{document, revision}` (or `null` with no project open).
2. `runDocumentTool` runs against that document.
3. If the tool changed it, `apply(document, revision)` sends it back; the editor applies it through `applyAgentDocumentIfCurrent` — the same revision-guarded apply an in-app chat turn uses — so it is saved and becomes **one undo step**.

A user edit that lands between 1 and 3 moves the revision and the apply is refused as a conflict; the client is told to re-read. The renderer also compares the project id, because the revision counter restarts at 0 when a project closes and a quick switch to another project could otherwise match. Calls are serialised in the main process so two of them never interleave.

Only the webContents that registered on `ai-edition.mcp-host` is asked, and only its replies count. An editor that unmounts or is destroyed stops being asked. A request unanswered for 30 s resolves to "no project" (reads) or `timeout` (writes, reported as "did not confirm", not as a failure, since the save may have landed).

## Transport and security

- Streamable HTTP, **stateless**: a fresh `McpServer` + transport per request, the SDK's documented shape for a server that keeps no session state.
- Bound to `127.0.0.1` only, endpoint `/mcp`, default port 47821 (configurable, 1024–65535).
- Every request needs `Authorization: Bearer <token>`, compared in constant time. The token is 32 random bytes, stored with `safeStorage`, and read only once the server is enabled, so users who never enable it never meet a Keychain prompt for it. Regenerating it restarts the server, so the old one stops working at once.
- The `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, and a request carrying any other `Origin` is refused — this blocks a web page from reaching the server through DNS rebinding.

## Lifecycle

`registerIpcHandlers` builds the `McpController` (it is where the agent's own dependencies — the cursor reader, the LLM config — live) and returns it; **`main.ts` starts it**. The headless CLI shares `registerIpcHandlers` and must never bind the port a running app is listening on, and a bench run has no use for it, so neither calls `startIfEnabled`.

## Connecting a client

The settings section shows both commands with the real URL, and copies them with the real token:

```sh
claude mcp add --transport http openscreen http://127.0.0.1:47821/mcp --header "Authorization: Bearer <token>"

export OPENSCREEN_MCP_TOKEN=<token>
codex mcp add openscreen --url http://127.0.0.1:47821/mcp --bearer-token-env-var OPENSCREEN_MCP_TOKEN
```

## Known gaps

- **Only what the agent can do.** The server exposes the agent's timeline tools. Recording, export, import and project management are not tools, for MCP or for the in-app agent.
- **An open editor is required.** With no editor window, or no project loaded, every tool answers "No project is open".
