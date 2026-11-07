/**
 * The transactional half of a CLI export.
 *
 * The native pass used to be told to write the user's path directly, and the voiceover was mixed
 * in afterwards, writing back over the same file. A failure in the second phase therefore left the
 * destination holding a file the user never asked for — an un-mixed export — while the command
 * reported failure. Measured on a real run: `58a9d80b…` (78.75 MB) became `c38e502a…` (77.75 MB).
 *
 * So the run is a transaction with three rules, and nothing here is allowed to break them:
 *
 *   1. The destination is never handed to a stage. Every stage writes to a sibling name of its
 *      own (`<base>.render-<token>.mp4`, `<base>.mixed-<token>.mp4`), on the same volume so the
 *      last step can be a rename.
 *   2. Nothing is committed before every stage has produced a file that survives a structural
 *      check. A file that was never written is not "empty but fine" — it is a refusal.
 *   3. Every stage is removed on the way out, success or failure. The commit is a rename, so a
 *      committed stage is already gone; the rest are litter.
 *
 * This module deliberately knows nothing about IPC, the native encoder, FFmpeg or the dialog. It
 * takes ports and an order, which is what makes the failure matrix testable without an app.
 */

export interface StagePaths {
	/** Phase 1: what the native compositor renders. */
	render: string;
	/** Phase 2: what the voiceover mix writes. Unused when the export has no audio. */
	mixed: string;
}

/** Split a path without `node:path`: this file also runs in the renderer. */
function splitPath(filePath: string): { dir: string; name: string; separator: string } {
	const lastForward = filePath.lastIndexOf("/");
	const lastBack = filePath.lastIndexOf("\\");
	const cut = Math.max(lastForward, lastBack);
	if (cut < 0) return { dir: "", name: filePath, separator: "/" };
	return {
		dir: filePath.slice(0, cut),
		name: filePath.slice(cut + 1),
		separator: filePath[cut] === "\\" ? "\\" : "/",
	};
}

function joinPath(dir: string, name: string, separator: string): string {
	return dir.length === 0 ? name : `${dir}${separator}${name}`;
}

/**
 * Stage names for one run, beside the final path.
 *
 * A sibling rather than the system temp directory, because the commit is a rename and a rename
 * cannot cross a volume — putting the stage on C: and the destination on D: would turn every
 * export into a copy. The token is caller-supplied (or random) so two concurrent runs of the same
 * destination cannot share a stage.
 */
export function stagePathsFor(finalPath: string, token?: string): StagePaths {
	const { dir, name, separator } = splitPath(finalPath);
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const suffix = token ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	return {
		render: joinPath(dir, `${stem}.render-${suffix}.mp4`, separator),
		mixed: joinPath(dir, `${stem}.mixed-${suffix}.mp4`, separator),
	};
}

/** `ftyp` at offset 4, and a `moov` box in either the head (faststart) or the tail. */
export function isMp4(bytes: Uint8Array): boolean {
	if (bytes.length < 12) return false;
	const ftyp = [0x66, 0x74, 0x79, 0x70]; // "ftyp"
	if (!ftyp.every((byte, i) => bytes[4 + i] === byte)) return false;

	const needle = [0x6d, 0x6f, 0x6f, 0x76]; // "moov"
	const window = 1024 * 1024;
	const head = bytes.subarray(0, Math.min(bytes.length, window));
	if (contains(head, needle)) return true;
	if (bytes.length <= window * 2) return contains(bytes, needle);
	return contains(bytes.subarray(bytes.length - window), needle);
}

function contains(haystack: Uint8Array, needle: number[]): boolean {
	const last = haystack.length - needle.length;
	outer: for (let i = 0; i <= last; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return true;
	}
	return false;
}

/** The stages the run is allowed to bolt on: render first, mixed only when there is audio. */
export interface ExportTransactionPorts {
	/** Native render, straight to the given stage. Never the destination. */
	render(stage: string, protectedPaths: readonly string[]): Promise<void>;
	readVideo(stage: string): Promise<ArrayBuffer>;
	readVoiceover(audioPath: string): Promise<ArrayBuffer>;
	mix(video: ArrayBuffer, voiceover: ArrayBuffer): Promise<ArrayBuffer>;
	writeStage(stage: string, bytes: ArrayBuffer, protectedPaths: readonly string[]): Promise<void>;
	commit(stage: string, finalPath: string, protectedPaths: readonly string[]): Promise<void>;
	/** Best-effort: a stage that is already gone is success. */
	remove(stage: string): Promise<void>;
	/**
	 * Check the destination BEFORE any encoding starts.
	 *
	 * The commit re-checks it anyway, so this is not the security boundary — it is the difference
	 * between refusing "that is a source file" in a millisecond and refusing it after a full
	 * render and a stage cleanup. Optional because a caller without a main process (tests, the
	 * browser shim) has nothing to ask.
	 */
	preflight?(finalPath: string, protectedPaths: readonly string[]): Promise<void>;
}

export interface ExportTransactionArgs {
	finalPath: string;
	protectedPaths: readonly string[];
	/** `null` for a plain video export, which commits the rendered stage directly. */
	audioPath: string | null;
	ports: ExportTransactionPorts;
	/** Fixed by tests; production generates one per run. */
	stages?: StagePaths;
}

export interface ExportTransactionResult {
	outputPath: string;
}

export async function runTransactionalExport(
	args: ExportTransactionArgs,
): Promise<ExportTransactionResult> {
	const { finalPath, protectedPaths, audioPath, ports } = args;
	const stages = args.stages ?? stagePathsFor(finalPath);
	// A stage only joins the cleanup list when something could have been created at that path:
	// a refusal before the encoder opens leaves nothing behind, and pretending otherwise would
	// make a refusal look like a mess.
	const stagesToClean: string[] = [];

	try {
		await ports.preflight?.(finalPath, protectedPaths);
		stagesToClean.push(stages.render);
		await ports.render(stages.render, protectedPaths);
		const rendered = await ports.readVideo(stages.render);
		requireMp4(rendered, "rendered video");

		let candidate = stages.render;
		if (audioPath) {
			stagesToClean.push(stages.mixed);
			// Read the voiceover BEFORE mixing: a missing or unreadable take has to fail the run
			// while the destination is still untouched, not after a second encode.
			const voiceover = await ports.readVoiceover(audioPath).catch((error: unknown) => {
				throw new Error(
					`Failed to read voiceover file: ${audioPath} — ${error instanceof Error ? error.message : String(error)}`,
				);
			});
			const mixed = await ports.mix(rendered, voiceover);
			requireMp4(mixed, "mixed video");
			await ports.writeStage(stages.mixed, mixed, protectedPaths);
			candidate = stages.mixed;
		}

		// The only line that can change what the user sees.
		await ports.commit(candidate, finalPath, protectedPaths);
		return { outputPath: finalPath };
	} finally {
		for (const stage of stagesToClean) {
			// Cleanup must never mask the real outcome: the caller needs the encoder's error, not
			// "could not unlink".
			await ports.remove(stage).catch(() => undefined);
		}
	}
}

function requireMp4(bytes: ArrayBuffer, label: string): void {
	if (bytes.byteLength === 0 || !isMp4(new Uint8Array(bytes))) {
		throw new Error(`The ${label} is not a usable MP4 (${bytes.byteLength} bytes).`);
	}
}
