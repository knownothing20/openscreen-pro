import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Removing the temp files a killed export left behind — and nothing else.
 *
 * Every export writes beside its destination under a name of its own making, and normally
 * removes it on the way out. A process that dies without running its `finally` (power loss,
 * Task Manager, a native crash) leaves that file on disk. Over months of long exports those
 * are gigabytes of litter in the folder the user exports to.
 *
 * The danger is obvious: this deletes files, automatically, in a directory full of the user's
 * own videos. So it is built around refusals rather than a rule:
 *
 *   1. The name must match one of the four shapes this app produces. A file called
 *      `holiday.mp4` is not a candidate no matter how old it is; nor is a `.render-` name with
 *      a token too short to be ours. Extension alone decides nothing.
 *   2. **Only names that carry their writer's pid are eligible at all.** A `.render-`/`.mixed-`
 *      stage has no pid, and a name is not ownership: another CLI process could own exactly
 *      that name, a user could have one, and V2.5's sweep would delete either after a day. Those
 *      are now reported as `unattributable` and left alone. A stage this run created is removed
 *      by this run's own `finally`, which is the only path with real ownership.
 *   3. The file must be older than {@link DEFAULT_MAX_AGE_MS}. An export that started a minute
 *      ago leaves exactly such a file, and deleting it would corrupt a live run.
 *   4. The pid in the name must be **provably dead**. "Signal 0 threw" is not the same as "the
 *      process is gone": EPERM means it exists and belongs to someone else, and any other errno
 *      means the question could not be answered. Both count as alive here — an unanswerable
 *      ownership question is not permission to delete.
 *
 * Anything uncertain is kept. A leftover file costs disk; a deleted one costs the user's
 * afternoon. And every failure is a log line — the sweep runs at the start of a real export and
 * must never be able to fail one.
 *
 * The scope is deliberately one directory. It is the directory the user is exporting to again,
 * which is the one place these files can accumulate, and it means no scan of a disk, no
 * recursion, and no surprise.
 */

/** A day is long enough that no live export looks abandoned, and short enough to matter. */
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type ExportTempKind = "render-stage" | "mixed-stage" | "encoder-partial" | "gif-partial";

export interface ExportTempName {
	kind: ExportTempKind;
	/** The pid recorded in the name, when it carries one. */
	pid: number | null;
}

/**
 * The transaction stages: `<stem>.<render|mixed>-<token>.mp4`, built by `stagePathsFor`.
 *
 * Same shape `isExportStageName` accepts, deliberately — a name the commit step would trust is
 * a name this may remove.
 */
const STAGE_NAME = /\.(render|mixed)-[A-Za-z0-9_-]{8,}\.mp4$/i;

/**
 * The encoder's own output: `<stem>.partial-<pid base36>-<nonce>.mp4`.
 *
 * `planExportWrite` builds it (`${base}.partial-${pid.toString(36)}-${uuid.slice(0, 8)}`), so it
 * covers the GUI target, a CLI stage, and the `.render-…` stage a transactional run hands the
 * encoder — the base is anything at all.
 */
const ENCODER_PARTIAL = /\.partial-([0-9a-z]+)-([0-9a-f]{8})\.(?:mp4|gif)$/i;

/** The GIF path stages under a dotfile with a decimal pid (`gif_export_control.rs`). */
const GIF_PARTIAL = /^\.openscreen-gif-(\d+)-[A-Za-z0-9]+\.partial$/;

/**
 * Which of this app's temp files is `fileName`, or null when it is not one.
 *
 * Pure and total: it never touches the disk, so the whitelist can be tested on its own and
 * reused wherever a name has to be judged.
 */
export function classifyExportTempName(fileName: string): ExportTempName | null {
	if (GIF_PARTIAL.test(fileName)) {
		return { kind: "gif-partial", pid: Number(fileName.match(GIF_PARTIAL)?.[1]) };
	}
	const partial = ENCODER_PARTIAL.exec(fileName);
	if (partial) {
		const pid = Number.parseInt(partial[1], 36);
		// A pid that parsed to nonsense (0 or NaN) is not a pid this can reason about; treating
		// it as "no pid" would make the file look abandoned, so the name is refused instead.
		return Number.isInteger(pid) && pid > 0 ? { kind: "encoder-partial", pid } : null;
	}
	const stage = STAGE_NAME.exec(fileName);
	if (stage) {
		return {
			kind: stage[1].toLowerCase() === "render" ? "render-stage" : "mixed-stage",
			pid: null,
		};
	}
	return null;
}

export interface SweepOptions {
	/**
	 * Files this process is writing right now, by absolute path.
	 *
	 * The stage names carry no pid, so this is what keeps a sweep from deleting the render of an
	 * export that is running at this very moment in another window.
	 */
	activePaths?: Iterable<string>;
	/** Fixed by tests. */
	now?: number;
	maxAgeMs?: number;
	/** Injected by tests; the real one asks the OS. */
	processState?: (pid: number) => ProcessState;
	warn?: (message: string) => void;
	/** Where a deliberate skip is recorded. */
	note?: (message: string) => void;
}

/** What the OS would say about a pid, including "it cannot say". */
export type ProcessState = "alive" | "dead" | "unknown";

export interface SweepResult {
	removed: string[];
	kept: Array<{
		path: string;
		reason: "active" | "not-expired" | "process-alive" | "process-unknown" | "unattributable";
	}>;
}

/**
 * Paths this process is writing right now, keyed by path and counted.
 *
 * A stage name carries no pid, so a sweep in one export would otherwise have to assume that a
 * `.render-` file it can see is abandoned. It cannot: a second export started a minute ago owns
 * exactly such a file. Registering the path at the moment the run starts makes the question
 * answerable instead of guessable, and the age rule stays as the second line of defence.
 */
const activeTemps = new Map<string, number>();

/** Registers `filePath` as in flight; the returned function releases it. Idempotent. */
export function trackActiveExportTemp(filePath: string): () => void {
	const key = comparable(filePath);
	activeTemps.set(key, (activeTemps.get(key) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const count = (activeTemps.get(key) ?? 1) - 1;
		if (count <= 0) activeTemps.delete(key);
		else activeTemps.set(key, count);
	};
}

/** The paths registered right now, for a sweep that must leave them alone. */
export function activeExportTemps(): string[] {
	return [...activeTemps.keys()];
}

/**
 * What the OS says about `pid`. Signal 0 only asks the question, it delivers nothing.
 *
 * Only ESRCH means "no such process". EPERM means it exists under another account, and anything
 * else (an unsupported platform, a syscall the sandbox refused) means the answer is unknown —
 * and unknown is treated as alive by the caller, because the cost of being wrong is a deleted
 * file.
 */
export function probeProcessState(pid: number): ProcessState {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
	}
}

function comparable(filePath: string): string {
	return path.resolve(filePath).toLowerCase();
}

/**
 * Delete the expired temp files of this app in `dir`. Never throws; never recurses.
 *
 * Called before an export starts, which is both the only moment the answer is useful and the
 * only moment the directory is certain to be the right one.
 */
export async function sweepStaleExportTemps(
	dir: string,
	options: SweepOptions = {},
): Promise<SweepResult> {
	const now = options.now ?? Date.now();
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const probe = options.processState ?? probeProcessState;
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const note = options.note ?? ((message: string) => console.info(message));
	const active = new Set<string>();
	for (const filePath of options.activePaths ?? []) active.add(comparable(filePath));

	const result: SweepResult = { removed: [], kept: [] };

	let entries: Dirent<string>[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// A destination directory that is not there yet is not a problem to report: the export
		// that follows creates it, and there was nothing to sweep.
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			warn(`[export] could not inspect ${dir} for leftover temp files: ${String(error)}`);
		}
		return result;
	}

	for (const entry of entries) {
		// `isFile` is false for a directory and for a symlink, which is the point: a link named
		// like a stage could point anywhere, and unlinking one must never follow it.
		if (!entry.isFile()) continue;
		const known = classifyExportTempName(entry.name);
		if (!known) continue;

		const filePath = path.join(dir, entry.name);
		if (active.has(comparable(filePath))) {
			result.kept.push({ path: filePath, reason: "active" });
			continue;
		}
		if (known.pid === null) {
			// A stage name: no writer to point at, so no proof this app made it. See rule 2 above.
			result.kept.push({ path: filePath, reason: "unattributable" });
			note(`[export] leaving an unattributable leftover in place: ${filePath}`);
			continue;
		}
		const state = probe(known.pid);
		if (state === "alive") {
			result.kept.push({ path: filePath, reason: "process-alive" });
			continue;
		}
		if (state === "unknown") {
			result.kept.push({ path: filePath, reason: "process-unknown" });
			continue;
		}

		let stats: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stats = await fs.stat(filePath);
		} catch {
			continue;
		}
		if (now - stats.mtimeMs < maxAgeMs) {
			result.kept.push({ path: filePath, reason: "not-expired" });
			continue;
		}

		try {
			await fs.unlink(filePath);
			result.removed.push(entry.name);
		} catch (error) {
			// A file another process still holds is not a failure of the export about to run.
			warn(`[export] could not remove a leftover temp file: ${filePath} (${String(error)})`);
		}
	}

	return result;
}
