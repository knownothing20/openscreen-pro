// Settings for the local MCP server: whether it runs, on which port, and the
// bearer token a client must present.
//
// Same split as LlmConfigStore: the non-secret part is plain JSON, the token is
// a credential and goes through the OS keychain (`safeStorage`), never plain
// JSON. The encryption is injected rather than imported so this file stays
// testable without Electron.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MCP_PORT = 47821;

export interface McpSettings {
	enabled: boolean;
	port: number;
	/**
	 * Whether MCP clients may run the tools that change the project. Off by
	 * default and separate from the in-app agent's "Project edits": turning the
	 * server on gives a client read access, and writing is a second decision.
	 */
	allowEdits: boolean;
}

export interface McpTokenCrypto {
	isEncryptionAvailable(): boolean;
	encryptString(plain: string): Buffer;
	decryptString(encrypted: Buffer): string;
}

export function isValidMcpPort(port: unknown): port is number {
	return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535;
}

export class McpSettingsStore {
	private readonly settingsPath: string;
	private readonly tokenPath: string;
	private settings: McpSettings;
	private token: string | null = null;

	constructor(
		userDataPath: string,
		private readonly crypto: McpTokenCrypto,
	) {
		this.settingsPath = path.join(userDataPath, "mcp-server.json");
		this.tokenPath = path.join(userDataPath, "mcp-token.enc");
		this.settings = this.readSettings();
	}

	private readSettings(): McpSettings {
		try {
			const raw = JSON.parse(readFileSync(this.settingsPath, "utf8")) as Partial<McpSettings>;
			return {
				enabled: raw.enabled === true,
				port: isValidMcpPort(raw.port) ? raw.port : DEFAULT_MCP_PORT,
				allowEdits: raw.allowEdits === true,
			};
		} catch {
			return { enabled: false, port: DEFAULT_MCP_PORT, allowEdits: false };
		}
	}

	getSettings(): McpSettings {
		return { ...this.settings };
	}

	async setSettings(patch: Partial<McpSettings>): Promise<McpSettings> {
		if (patch.port !== undefined && !isValidMcpPort(patch.port)) {
			throw new Error("Port must be a whole number between 1024 and 65535.");
		}
		this.settings = { ...this.settings, ...patch };
		await fs.writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf8");
		return this.getSettings();
	}

	/**
	 * The token, created on first use. Read lazily: on macOS the decrypt is a
	 * Keychain access, which must not happen for users who never turn MCP on.
	 */
	async getToken(): Promise<string> {
		if (this.token) return this.token;
		try {
			const encrypted = readFileSync(this.tokenPath);
			if (this.crypto.isEncryptionAvailable()) {
				const token = this.crypto.decryptString(encrypted);
				if (token) {
					this.token = token;
					return token;
				}
			}
		} catch {
			// No token yet, or unreadable — mint a fresh one below.
		}
		return this.regenerateToken();
	}

	/** Replace the token. Every client configured with the old one stops working. */
	async regenerateToken(): Promise<string> {
		if (!this.crypto.isEncryptionAvailable()) {
			throw new Error("safeStorage is not available on this platform.");
		}
		const token = randomBytes(32).toString("base64url");
		await fs.writeFile(this.tokenPath, this.crypto.encryptString(token));
		this.token = token;
		return token;
	}
}
