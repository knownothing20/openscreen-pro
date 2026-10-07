// Owns the MCP server's lifecycle: start it when enabled, restart it when its
// port or token changes, stop it when disabled, and report status to settings.
//
// Off by default. While it is off nothing listens and the token is never read,
// so a user who never turns it on never meets a Keychain prompt for it.

import type { AiEditionMcpStatus } from "../../src/native/contracts";
import type { McpSettingsStore } from "./mcp-settings-store";
import {
	MCP_ENDPOINT_PATH,
	type McpToolDeps,
	type RunningMcpServer,
	startMcpHttpServer,
} from "./openscreen-mcp-server";

export class McpController {
	private running: RunningMcpServer | null = null;
	private error: string | null = null;
	/** Serialises start/stop so a quick toggle cannot leave two servers bound. */
	private transition: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly store: McpSettingsStore,
		private readonly deps: McpToolDeps,
	) {}

	private serially<T>(task: () => Promise<T>): Promise<T> {
		const next = this.transition.then(task, task);
		this.transition = next.catch(() => undefined);
		return next;
	}

	private async stopNow(): Promise<void> {
		const running = this.running;
		this.running = null;
		await running?.close();
	}

	/** (Re)start from the stored settings — or stop, if they say disabled. */
	private async applySettings(): Promise<void> {
		await this.stopNow();
		this.error = null;
		const { enabled, port } = this.store.getSettings();
		if (!enabled) return;
		try {
			const token = await this.store.getToken();
			this.running = await startMcpHttpServer({ port, token, deps: this.deps });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | null)?.code;
			this.error =
				code === "EADDRINUSE"
					? `Port ${port} is already in use. Choose another port.`
					: error instanceof Error
						? error.message
						: String(error);
		}
	}

	startIfEnabled(): Promise<void> {
		return this.serially(() => this.applySettings());
	}

	stop(): Promise<void> {
		return this.serially(() => this.stopNow());
	}

	async getStatus(): Promise<AiEditionMcpStatus> {
		await this.transition;
		const { enabled, port, allowEdits } = this.store.getSettings();
		let token: string | null = null;
		if (enabled) {
			try {
				token = await this.store.getToken();
			} catch {
				// Surfaced through `error` already, from the failed start.
			}
		}
		return {
			enabled,
			port,
			allowEdits,
			running: this.running !== null,
			url: `http://127.0.0.1:${port}${MCP_ENDPOINT_PATH}`,
			token,
			error: this.error,
		};
	}

	async setEnabled(enabled: boolean): Promise<AiEditionMcpStatus> {
		await this.serially(async () => {
			await this.store.setSettings({ enabled });
			await this.applySettings();
		});
		return this.getStatus();
	}

	async setPort(port: number): Promise<AiEditionMcpStatus> {
		await this.serially(async () => {
			await this.store.setSettings({ port });
			await this.applySettings();
		});
		return this.getStatus();
	}

	/** No restart needed: the server reads it on every call. */
	async setAllowEdits(allowEdits: boolean): Promise<AiEditionMcpStatus> {
		await this.serially(() => this.store.setSettings({ allowEdits }));
		return this.getStatus();
	}

	/** New token; the running server is restarted so the old one stops working at once. */
	async regenerateToken(): Promise<AiEditionMcpStatus> {
		await this.serially(async () => {
			await this.store.regenerateToken();
			await this.applySettings();
		});
		return this.getStatus();
	}
}
