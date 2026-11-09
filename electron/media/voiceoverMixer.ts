import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { discardExportFile } from "../exportPathGuard";
import { resolveFfmpeg } from "./audioPeaks";

/**
 * The voiceover mix, done as a file-to-file job in the main process.
 *
 * What it replaces, and why. The CLI used to read the finished render into the renderer as an
 * ArrayBuffer, decode the whole audio bed with `decodeAudioData`, render the mix with an
 * `OfflineAudioContext` sized to the whole video, mux it back with mediabunny into a
 * `BufferTarget`, and post the entire MP4 back over IPC. On a ten-minute 1080p60 export that
 * was ~1.8 GB of renderer memory, and on thirty minutes ~4.6 GB — all of it to produce an
 * audio track. The video was never touched in any of those steps.
 *
 * So the work moves to ffmpeg: it reads the render and the voiceover from disk, copies the video
 * packets untouched, decodes only audio, and writes the mixed MP4 to the stage. Nothing larger
 * than a frame or an audio block is ever held by a JS process.
 *
 * The semantics are the old ones, deliberately, and they are listed in `buildFilterGraph`:
 * the render's own track at 0.4, the voiceover at 1.0, the voiceover starting at `offsetSec`,
 * 48 kHz stereo AAC at 192 kbit/s, and the video's length as the final length. `replace` drops
 * the bed entirely. A render with no audio stream falls back to the voiceover alone — which is
 * what the old code did when the bed failed to decode, not a new behaviour.
 */

export type VoiceoverMixMode = "mix" | "replace";

/** Same ducking gain the browser mixer applied to the original track, unchanged on purpose. */
export const DEFAULT_ORIGINAL_GAIN = 0.4;
export const OUTPUT_SAMPLE_RATE = 48_000;
export const OUTPUT_CHANNELS = 2;
export const VOICEOVER_AUDIO_BITRATE = 192_000;

export interface VoiceoverMixRequest {
	/** The finished render: a private stage, never the user's file. */
	renderPath: string;
	/** The voiceover file the user picked. Read only. */
	voiceoverPath: string;
	/** Where the mixed MP4 goes: again a private stage, never the user's file. */
	outPath: string;
	mode: VoiceoverMixMode;
	/** Seconds of silence before the voiceover starts. Negative values mean zero. */
	offsetSec: number;
	/** Gain applied to the render's own track in "mix" mode. */
	originalGain?: number;
}

export interface VoiceoverMixOptions {
	/** Kills this mix's own child process. Nothing else is touched. */
	signal?: AbortSignal;
	/** Fixed by tests; production resolves the packaged binary. */
	ffmpegPath?: string;
	/** Fixed by tests. */
	now?: () => number;
}

export interface VoiceoverMixResult {
	outPath: string;
	/** Whether the render had an audio track to mix into (false = voiceover only). */
	hasBed: boolean;
	/** The binary that did the work, so the report can name it instead of guessing. */
	ffmpegPath: string;
	wallMs: number;
}

/** Thrown when the mix was stopped on purpose, so callers can tell it from a failure. */
export class VoiceoverMixCancelled extends Error {
	readonly code = "MIX_CANCELLED";
	constructor() {
		super("The voiceover mix was cancelled.");
		this.name = "VoiceoverMixCancelled";
	}
}

/** Numbers in a filter graph must never carry a locale decimal comma or an exponent. */
function num(value: number): string {
	const rounded = Math.round(value * 1000) / 1000;
	return Number.isFinite(rounded) ? String(rounded) : "0";
}

export interface FilterGraphOptions {
	/** The render has an audio track worth mixing in. */
	hasBed: boolean;
	mode: VoiceoverMixMode;
	offsetSec: number;
	originalGain: number;
	/**
	 * Channel counts of the two inputs, when known.
	 *
	 * A mono source needs `pan` rather than `aformat`: this ffmpeg's mono→stereo up-mix scales
	 * each channel by 0.707, which is a 3 dB drop against the browser mixer's rule (duplicate
	 * the mono channel into both, unity). Measured on the 8-second fixture: -21.07 dBFS in,
	 * -24.09 dBFS out, until the graph said what it meant.
	 */
	bedChannels?: number | null;
	voiceChannels?: number | null;
}

/**
 * The filter chain that lands any input on 48 kHz stereo at its own level.
 *
 * A mono source needs `pan`, not `aformat`: this ffmpeg's mono→stereo up-mix scales each channel
 * by 0.707, which measures as 3 dB down against the browser mixer's rule (duplicate the mono
 * channel into both, unity). Found by the acceptance matrix, not by reading the docs — a mono
 * voiceover came out at -24.09 dBFS where the source was -21.07.
 */
function stereoChain(channels: number | null | undefined): string {
	return channels === 1
		? `aresample=${OUTPUT_SAMPLE_RATE},pan=stereo|c0=c0|c1=c0`
		: `aresample=${OUTPUT_SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;
}

/**
 * The exact filter graph, built from the old mixer's behaviour.
 *
 * - The bed is scaled by `originalGain` (0.4), the voiceover is not scaled at all.
 * - `amix` runs with `normalize=0`: the default would halve both inputs, which is the
 *   "volume drops when I add a voiceover" bug this must not introduce. With normalization off,
 *   the sum is the same arithmetic the browser did (`bed*0.4 + voiceover`).
 * - `dropout_transition` is left at its default on purpose. Setting it to 0 looks like "no
 *   ramp, so no step", and measures as the opposite: with two inputs and `normalize=0`, the
 *   bed drops by **3 dB** the moment the voiceover ends (measured with `volumedetect` on a
 *   440 Hz bed: -29.0 dB → -32.0 dB). Leaving the default reproduces the plain sum the browser
 *   did, at every point of the timeline.
 * - `apad` on the output guarantees the audio is never shorter than the video; the caller's
 *   `-shortest` then ends the file with the video, which is the old "the timeline decides the
 *   length" rule. Padding rather than `-t` because the mixer deliberately does not probe the
 *   duration — `-shortest` needs no number and cannot truncate a long video, since the padded
 *   audio is always the longer stream.
 * - Every branch resamples to 48 kHz and forces stereo, matching the old OfflineAudioContext.
 */
export function buildFilterGraph(options: FilterGraphOptions): string {
	const delayMs = Math.max(0, Math.round(options.offsetSec * 1000));
	const delay = delayMs > 0 ? `adelay=delays=${delayMs}:all=1,` : "";
	const voice = `[1:a]${delay}${stereoChain(options.voiceChannels)}[vo]`;

	if (options.mode === "replace" || !options.hasBed) {
		return `${voice};[vo]apad[aout]`;
	}
	const bed = `[0:a]volume=${num(options.originalGain)},${stereoChain(options.bedChannels)}[bed]`;
	return `${bed};${voice};[bed][vo]amix=inputs=2:duration=longest:normalize=0,apad[aout]`;
}

/**
 * The argv for one mix. Kept pure so the argument list can be asserted without spawning.
 *
 * `-c:v copy` is the whole point: the video packets, their timestamps and their codec tag
 * (`avc1` / `hvc1`) pass through untouched. Nothing here may name a video encoder.
 */
export function buildMixArgs(
	request: VoiceoverMixRequest,
	hasBed: boolean,
	channels: { bed: number | null; voice: number | null } = { bed: null, voice: null },
): string[] {
	const graph = buildFilterGraph({
		hasBed,
		mode: request.mode,
		offsetSec: request.offsetSec,
		originalGain: request.originalGain ?? DEFAULT_ORIGINAL_GAIN,
		bedChannels: channels.bed,
		voiceChannels: channels.voice,
	});
	return [
		"-nostdin",
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostats",
		"-y",
		"-i",
		request.renderPath,
		"-i",
		request.voiceoverPath,
		"-filter_complex",
		graph,
		"-map",
		"0:v:0",
		"-map",
		"[aout]",
		"-c:v",
		"copy",
		"-c:a",
		"aac",
		"-b:a",
		String(VOICEOVER_AUDIO_BITRATE),
		"-ar",
		String(OUTPUT_SAMPLE_RATE),
		"-ac",
		String(OUTPUT_CHANNELS),
		// The padded audio is always at least as long as the video, so this can only ever cut
		// audio — never the video, which is the failure `-shortest` is usually blamed for.
		"-shortest",
		"-f",
		"mp4",
		request.outPath,
	];
}

/**
 * Where ffmpeg writes while it works: the stage's name with the app's own `.partial-` suffix.
 *
 * Two reasons, both about a killed process. A crash cannot leave a file that looks like a
 * finished mixed stage, and the leftover carries **this process's pid** — which is the only
 * evidence the sweep accepts. A name with no pid (a plain `.mixed-<token>.mp4`) is deliberately
 * not swept, so writing straight to the stage would leave litter nothing may ever remove.
 *
 * Same shape `planExportWrite` builds, so one regex covers every partial this app produces.
 */
export function mixPartialPath(outPath: string): string {
	const dir = path.dirname(outPath);
	const name = path.basename(outPath);
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const suffix = `${process.pid.toString(36)}-${randomUUID().slice(0, 8)}`;
	return path.join(dir, `${stem}.partial-${suffix}.mp4`);
}

/** Keeps only the tail of a child's stderr: a 30-minute mix can log a line per frame. */
const STDERR_TAIL_BYTES = 8 * 1024;

function tailAppend(current: string, chunk: Buffer): string {
	const next = current + chunk.toString("utf8");
	return next.length > STDERR_TAIL_BYTES ? next.slice(-STDERR_TAIL_BYTES) : next;
}

function runChild(
	ffmpegPath: string,
	args: string[],
	options: { signal?: AbortSignal; expectSuccess: boolean },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(ffmpegPath, args, {
				// Array argv and no shell: a path with a space, a quote or Chinese characters is
				// passed as one argument instead of being re-split by cmd.exe.
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			reject(error);
			return;
		}

		let stderr = "";
		let aborted = false;
		const onAbort = () => {
			aborted = true;
			child.kill("SIGTERM");
			// ffmpeg handles SIGTERM and exits within a frame or two; the timer is for the case
			// where it is wedged in a muxer and ignores the first signal.
			setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, 3_000).unref?.();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", () => {
			// Media never goes to stdout here (the output is a file), and progress stats are off.
			// Draining keeps the pipe from filling and stalling the child.
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = tailAppend(stderr, chunk);
		});
		child.once("error", (error) => {
			options.signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.once("close", (code, signal) => {
			options.signal?.removeEventListener("abort", onAbort);
			if (aborted) {
				reject(new VoiceoverMixCancelled());
				return;
			}
			if (options.expectSuccess && code !== 0) {
				const detail = stderr.trim() || `ffmpeg exited with ${code ?? signal}`;
				reject(new Error(`ffmpeg failed (${code ?? signal}): ${detail}`));
				return;
			}
			resolve({ code, signal, stderr });
		});
	});
}

/**
 * Does the render carry an audio stream at all?
 *
 * Needed because the graph's `[0:a]` is a hard reference: a file without audio would fail the
 * filter instead of mixing the voiceover alone. `fetch`-ing the file to ask was the old way and
 * is exactly what this round removes, so the question is asked of the same binary that will do
 * the work — `ffmpeg -i <file>` prints the streams and reads headers only, no decode.
 */
export interface AudioProbe {
	hasAudio: boolean;
	/** 1 for mono, 2 for stereo, null when the layout is something else or unreadable. */
	channels: number | null;
}

export async function probeAudioStream(
	ffmpegPath: string,
	filePath: string,
	options: { signal?: AbortSignal } = {},
): Promise<AudioProbe> {
	const result = await runChild(ffmpegPath, ["-nostdin", "-hide_banner", "-i", filePath], {
		signal: options.signal,
		// No output file was given, so this always exits non-zero ("At least one output file
		// must be specified"). The verdict is in the stream table, not the exit code.
		expectSuccess: false,
	});
	if (!/Input #0,/.test(result.stderr)) {
		throw new Error(
			`Cannot read media: ${filePath} — ${result.stderr.split("\n").slice(-3).join(" ").trim()}`,
		);
	}
	const line = /^\s*Stream #0:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio:.*$/m.exec(
		result.stderr,
	)?.[0];
	if (!line) return { hasAudio: false, channels: null };
	// `…, 48000 Hz, stereo, fltp, 2 kb/s` — the layout word is what decides the up-mix rule.
	if (/,\s*mono,/.test(line)) return { hasAudio: true, channels: 1 };
	if (/,\s*stereo,/.test(line)) return { hasAudio: true, channels: 2 };
	return { hasAudio: true, channels: null };
}

/**
 * Mix the voiceover into the render, on disk.
 *
 * The output path is a private stage the caller owns: on failure it is removed here so a
 * half-written file cannot be mistaken for a result, and on cancel the child is stopped before
 * the file is unlifted — a file still open by the dying child would be locked on Windows.
 */
export async function mixVoiceoverToFile(
	request: VoiceoverMixRequest,
	options: VoiceoverMixOptions = {},
): Promise<VoiceoverMixResult> {
	const startedAt = options.now?.() ?? Date.now();
	const ffmpegPath = options.ffmpegPath ?? resolveFfmpeg();
	if (!ffmpegPath) {
		throw new Error(
			"The bundled FFmpeg was not found, so the voiceover cannot be mixed. Reinstall the app or set OPENSCREEN_FFMPEG_PATH.",
		);
	}
	for (const input of [request.renderPath, request.voiceoverPath]) {
		const stats = (() => {
			try {
				return statSync(input);
			} catch {
				return null;
			}
		})();
		if (!stats?.isFile() || stats.size === 0) {
			throw new Error(`Cannot mix: the file does not exist or is empty: ${input}`);
		}
	}
	if (
		path.resolve(request.renderPath).toLowerCase() === path.resolve(request.outPath).toLowerCase()
	) {
		throw new Error("Cannot mix: the output would overwrite the rendered video.");
	}

	try {
		const bedProbe = await probeAudioStream(ffmpegPath, request.renderPath, {
			signal: options.signal,
		});
		const voiceProbe = await probeAudioStream(ffmpegPath, request.voiceoverPath, {
			signal: options.signal,
		});
		if (!voiceProbe.hasAudio) {
			throw new Error(`The voiceover has no audio stream: ${request.voiceoverPath}`);
		}
		const hasBed = bedProbe.hasAudio;
		const partial = mixPartialPath(request.outPath);
		const args = buildMixArgs({ ...request, outPath: partial }, hasBed, {
			bed: bedProbe.channels,
			voice: voiceProbe.channels,
		});
		await runChild(ffmpegPath, args, {
			signal: options.signal,
			expectSuccess: true,
		}).catch(async (error: unknown) => {
			// `discardExportFile` retries the EBUSY/EPERM window Windows keeps on a file whose
			// writer was just killed — the cancel case, precisely.
			await discardExportFile(partial);
			throw error;
		});
		const produced = (() => {
			try {
				return statSync(partial);
			} catch {
				return null;
			}
		})();
		if (!produced?.isFile() || produced.size === 0) {
			await discardExportFile(partial);
			throw new Error("ffmpeg reported success but wrote no output file.");
		}
		// The commit point of this step, and the only name the caller ever sees.
		try {
			await fs.rename(partial, request.outPath);
		} catch (error) {
			await discardExportFile(partial);
			throw error;
		}
		return {
			outPath: request.outPath,
			hasBed,
			ffmpegPath,
			wallMs: (options.now?.() ?? Date.now()) - startedAt,
		};
	} catch (error) {
		// Nothing half-written may be left under either name.
		await discardExportFile(request.outPath);
		throw error;
	}
}
