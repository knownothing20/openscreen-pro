import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Where an export is allowed to land, and how it gets there without destroying what was
 * already at that path.
 *
 * The export used to hand the user's chosen path straight to the encoder, which opens it for
 * writing. That has three failure modes, all of them the user's data:
 *
 *   - The path is a source recording. `showOverwriteConfirmation` asks "replace this file?"
 *     and the user, thinking about the export they just named, says yes — and the footage
 *     the project points at is gone. The renderer knows which files those are, but the only
 *     copy that matters is the one in this payload, so the check reads it from the clips
 *     being exported rather than from a second list that could drift.
 *   - The write fails halfway (disk full, codec error, cancellation). The old file has
 *     already been truncated by then, so a failed export leaves a broken file where a good
 *     one used to be — worse than leaving the user's previous version alone.
 *   - The process dies mid-export. Same as above, with no chance to clean up.
 *
 * So: encode into a sibling file, and only put it in place once there is a complete one to
 * put there. The rename is the commit point.
 *
 * "Is this the same file" is answered by the filesystem, not by the string: see
 * {@link canonicalPath} and {@link fileIdentity}. A string compare is right about the easy
 * case and silently wrong about the ones that actually destroy a recording.
 */

/** Exports only ever produce these. Also what keeps a project file from being a target. */
const EXPORT_EXTENSIONS = [".mp4", ".gif"];

/** Comparison is case-insensitive because the filesystem is: `C:\Clips\A.MP4` and
 *  `c:\clips\a.mp4` are one file on Windows, and the guard must not be fooled by case. */
function comparable(filePath: string): string {
	return path.resolve(filePath).toLowerCase();
}

type Resolution = { canonical: string } | { refusal: string };

/**
 * The path the OS would actually touch, with every symlink and `.`/`..` resolved.
 *
 * A target that does not exist yet still has an identity: it lives in a directory that does,
 * so the walk stops at the deepest existing ancestor and re-attaches the rest. That is also
 * how a symlinked *directory* is caught — `C:\link\to\clips\new-export.mp4` resolves through
 * the link, and a source living behind it compares equal.
 *
 * Two things are refused rather than guessed: a component that exists but is not a
 * directory (the write could not happen anyway, and calling it "nothing to protect" would be
 * a lie), and any IO error other than "does not exist" (a permission problem means we cannot
 * say what this path is).
 */
async function canonicalPath(filePath: string): Promise<Resolution> {
	let current = path.resolve(filePath);
	const tail: string[] = [];
	for (;;) {
		try {
			const stats = await fs.stat(current);
			// An existing ancestor must be a directory; only the target itself may be a file.
			if (tail.length > 0 && !stats.isDirectory()) {
				return { refusal: `“${current}” is not a directory.` };
			}
			const real = await fs.realpath(current);
			return { canonical: path.join(real, ...tail).toLowerCase() };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				return { refusal: `Could not resolve “${filePath}” (${code ?? String(error)}).` };
			}
			const parent = path.dirname(current);
			if (parent === current) {
				return { refusal: `Could not resolve “${filePath}”.` };
			}
			tail.unshift(path.basename(current));
			current = parent;
		}
	}
}

/**
 * `dev:ino` — the identity the filesystem gives a file, which is how two names for the same
 * bytes are recognised as one. A hard link has no path relationship to its twin at all, so
 * this is the only thing that catches it. `null` when the file is not there (nothing to
 * compare) or cannot be stat'ed.
 */
async function fileIdentity(filePath: string): Promise<string | null> {
	try {
		const stats = await fs.stat(filePath);
		return `${stats.dev}:${stats.ino}`;
	} catch {
		return null;
	}
}

const SAME_FILE_REASON =
	"That path is a source file this export is reading from. Pick another name — " +
	"overwriting it would destroy the footage the project needs.";

export interface ExportWritePlan {
	/** Where the encoder writes. Never the user's path. */
	tempPath: string;
	/** Where the finished file ends up — the user's path. */
	finalPath: string;
}

export type ExportWriteRefusal = { reason: string };

export interface ExportWriteOptions {
	/**
	 * Files the caller knows this export is reading but which are not clips.
	 *
	 * `write-export-to-path` reads the export it just made and the voiceover file, then
	 * writes the mix back over the former — so that entry point has no clips to derive a
	 * protected list from. The renderer passes the ones it knows; the list is additive, never
	 * a replacement for the clip sources.
	 */
	extraProtected?: readonly string[];
	/** Fixed only by tests: production temp names must never be predictable. */
	token?: string;
}

/**
 * The paths this export must not write over: every clip's screen and webcam source.
 *
 * Read off the clips rather than passed in separately, so there is no state to keep in sync
 * — an export is by definition about these files, and a guard that could be told the wrong
 * list is not a guard.
 */
export function exportedSourcePaths(
	clips: ReadonlyArray<{ screenPath?: string; webcamPath?: string }> | undefined,
): string[] {
	const out: string[] = [];
	for (const clip of clips ?? []) {
		for (const candidate of [clip?.screenPath, clip?.webcamPath]) {
			if (typeof candidate === "string" && candidate.length > 0) out.push(candidate);
		}
	}
	return out;
}

/**
 * Decide whether `outPath` may be written, and if so, where the encoder should write.
 *
 * Returns a refusal rather than throwing: the caller is an IPC handler that has to answer
 * with a message the UI can show, and a thrown error would arrive there as "export failed"
 * with no cause.
 */
export async function planExportWrite(
	outPath: string | undefined,
	clips: ReadonlyArray<{ screenPath?: string; webcamPath?: string }> | undefined,
	options: ExportWriteOptions = {},
): Promise<ExportWritePlan | ExportWriteRefusal> {
	if (typeof outPath !== "string" || outPath.length === 0) {
		// The compositor picks its own default path; there is nothing here to protect, and
		// inventing one would be a different behaviour from the one that exists.
		return { reason: "No export path was given." };
	}
	if (!path.isAbsolute(outPath)) {
		return { reason: "Export path must be absolute." };
	}
	const extension = path.extname(outPath).toLowerCase();
	if (!EXPORT_EXTENSIONS.includes(extension)) {
		return { reason: `Export path must end in ${EXPORT_EXTENSIONS.join(" or ")}.` };
	}

	const resolvedTarget = await canonicalPath(outPath);
	if ("refusal" in resolvedTarget) return { reason: resolvedTarget.refusal };
	const targetCanonical = resolvedTarget.canonical;
	const targetIdentity = await fileIdentity(outPath);

	const protectedPaths = [
		...exportedSourcePaths(clips),
		...(options.extraProtected ?? []).filter(
			(p): p is string => typeof p === "string" && p.length > 0,
		),
	];
	for (const source of protectedPaths) {
		// Canonical first: catches case, `.`/`..`, and symlinks. Then the filesystem's own
		// identity, which is the only thing that catches a hard link.
		const resolvedSource = await canonicalPath(source);
		const sourceCanonical =
			"canonical" in resolvedSource ? resolvedSource.canonical : comparable(source);
		if (sourceCanonical === targetCanonical) return { reason: SAME_FILE_REASON };

		if (targetIdentity) {
			const sourceIdentity = await fileIdentity(source);
			if (sourceIdentity && sourceIdentity === targetIdentity) return { reason: SAME_FILE_REASON };
		}
	}

	const finalPath = path.resolve(outPath);
	// Same directory, by construction: a rename cannot cross a volume, and the whole point
	// of the temp file is that the last step is a rename. The extension stays last so the
	// muxer still recognises the container it is being asked to write. The token carries the
	// pid as well as a random tail, so two exports — in the same process or two of them —
	// cannot land on each other's temp file.
	const dir = path.dirname(finalPath);
	const base = path.basename(finalPath, extension);
	const suffix = options.token ?? `${process.pid.toString(36)}-${randomUUID().slice(0, 8)}`;
	return {
		tempPath: path.join(dir, `${base}.partial-${suffix}${extension}`),
		finalPath,
	};
}

export function isExportRefusal(
	plan: ExportWritePlan | ExportWriteRefusal,
): plan is ExportWriteRefusal {
	return "reason" in plan;
}

/**
 * Put the finished temp file where the user asked for it.
 *
 * `rename` replaces the destination in one step on the same volume, which is what makes a
 * previous good export survive until the new one is complete. A cross-volume destination
 * cannot happen here (the temp file is created beside the target), so a rename failure is a
 * real error — and the temp file is dropped on the way out, because a failed commit is
 * exactly the moment an orphan would otherwise be left behind.
 */
export async function commitExportFile(plan: ExportWritePlan): Promise<void> {
	try {
		await fs.rename(plan.tempPath, plan.finalPath);
	} catch (error) {
		await discardExportFile(plan.tempPath);
		throw error;
	}
}

/**
 * Drop a temp file that will never be committed.
 *
 * Best-effort by contract, and it must never throw. Two reasons, both learned from a real run:
 *
 *  - Missing is success. A cancelled export's pipeline may have removed the file already.
 *  - Windows keeps the file locked for a moment after the writer lets go, and a CANCELLED export
 *    is exactly the case where the writer was interrupted mid-frame. The first `unlink` comes
 *    back `EBUSY`, and letting that escape turned "the user pressed Cancel" into "the export
 *    failed" — the dialog showed a raw EBUSY instead of returning to its options, and the temp
 *    file stayed on disk. So a lock is retried briefly, and anything else is given up on.
 *
 * A file that survives all of that is left behind and reported, because the alternative — failing
 * the operation the user asked for over a file they never see — is strictly worse.
 */
const DISCARD_RETRY_MS = [0, 30, 60, 120, 240, 480];

export async function discardExportFile(tempPath: string): Promise<void> {
	for (const delay of DISCARD_RETRY_MS) {
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		try {
			await fs.rm(tempPath, { force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// `force` already swallows ENOENT. A lock may clear on its own; anything else will
			// not, so waiting again is pointless.
			if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") return;
		}
	}
	console.warn(`[export] could not remove the temporary export file: ${tempPath}`);
}
