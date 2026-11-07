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
 */

/** Exports only ever produce these. Also what keeps a project file from being a target. */
const EXPORT_EXTENSIONS = [".mp4", ".gif"];

/** Comparison is case-insensitive because the filesystem is: `C:\Clips\A.MP4` and
 *  `c:\clips\a.mp4` are one file on Windows, and the guard must not be fooled by case. */
function comparable(filePath: string): string {
	return path.resolve(filePath).toLowerCase();
}

export interface ExportWritePlan {
	/** Where the encoder writes. Never the user's path. */
	tempPath: string;
	/** Where the finished file ends up — the user's path. */
	finalPath: string;
}

export type ExportWriteRefusal = { reason: string };

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
export function planExportWrite(
	outPath: string | undefined,
	clips: ReadonlyArray<{ screenPath?: string; webcamPath?: string }> | undefined,
	token: string = randomUUID().slice(0, 8),
): ExportWritePlan | ExportWriteRefusal {
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

	const target = comparable(outPath);
	const sources = exportedSourcePaths(clips).map(comparable);
	if (sources.includes(target)) {
		return {
			reason:
				"That path is a source file this export is reading from. Pick another name — " +
				"overwriting it would destroy the footage the project needs.",
		};
	}

	const finalPath = path.resolve(outPath);
	// Same directory, by construction: a rename cannot cross a volume, and the whole point
	// of the temp file is that the last step is a rename. The extension stays last so the
	// muxer still recognises the container it is being asked to write.
	const dir = path.dirname(finalPath);
	const base = path.basename(finalPath, extension);
	return {
		tempPath: path.join(dir, `${base}.partial-${token}${extension}`),
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
 * real error and is reported rather than papered over with a copy.
 */
export async function commitExportFile(plan: ExportWritePlan): Promise<void> {
	await fs.rename(plan.tempPath, plan.finalPath);
}

/**
 * Drop a temp file that will never be committed. Missing is success: a cancelled export may
 * have removed it already, and a cleanup that throws over that would turn "the export was
 * cancelled" into "the export failed".
 */
export async function discardExportFile(tempPath: string): Promise<void> {
	await fs.rm(tempPath, { force: true });
}
