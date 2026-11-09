import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyExportTempName } from "../exportTempSweep";
import { resolveFfmpeg } from "./audioPeaks";
import {
	buildFilterGraph,
	buildMixArgs,
	DEFAULT_ORIGINAL_GAIN,
	mixPartialPath,
	mixVoiceoverToFile,
	probeAudioStream,
	VoiceoverMixCancelled,
	type VoiceoverMixRequest,
} from "./voiceoverMixer";

/**
 * The mixer's two halves are tested differently on purpose.
 *
 * The argument list and the filter graph are pure functions, so they are pinned exactly: a
 * digit changing in `volume=0.4` or `normalize=0` is the difference between the old semantics
 * and "the voiceover made everything quieter".
 *
 * The media tests spawn the packaged ffmpeg and measure the output. They are written to fail
 * loudly on a machine without it rather than to pass vacuously — except where the fixture
 * itself cannot be produced (an HEVC encoder needs a GPU), which is skipped by name.
 */

const ffmpeg = resolveFfmpeg();

const run = (args: string[]): Promise<{ code: number; stderr: string; stdout: Buffer }> =>
	new Promise((resolve, reject) => {
		execFile(
			ffmpeg as string,
			args,
			{ encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
				const code = (error as { code?: number } | null)?.code ?? 0;
				if (error && typeof code !== "number") reject(error);
				else resolve({ code, stdout, stderr: stderr.toString() });
			},
		);
	});

let dir = "";
let fixture = "";

/** 3 s of test pattern with a 440 Hz bed — the "original audio" side of the matrix. */
async function makeVideo(target: string, options: { withAudio?: boolean; seconds?: number } = {}) {
	const seconds = options.seconds ?? 3;
	const args = [
		"-nostdin",
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`testsrc=size=320x240:rate=30:duration=${seconds}`,
	];
	if (options.withAudio !== false) {
		args.push("-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`);
	}
	args.push("-c:v", "libopenh264");
	if (options.withAudio !== false) args.push("-c:a", "aac", "-b:a", "128k", "-shortest");
	args.push(target);
	const { code, stderr } = await run(args);
	if (code !== 0) throw new Error(`fixture video failed: ${stderr}`);
}

async function makeTone(target: string, frequency: number, seconds: number, extra: string[] = []) {
	const { code, stderr } = await run([
		"-nostdin",
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=${frequency}:sample_rate=48000:duration=${seconds}`,
		...extra,
		target,
	]);
	if (code !== 0) throw new Error(`fixture audio failed: ${stderr}`);
}

/**
 * Mono float PCM of a window.
 *
 * The whole track is decoded once and sliced here rather than seeking per window: `-ss` before
 * `-i` on a short MP4 landed somewhere other than the requested second on this machine (a 0.5 s
 * window at 2.0 s came back at the level of the *voiceover*), and a measurement helper that can
 * silently read the wrong samples is worse than a slower one.
 */
async function pcmWindow(
	file: string,
	startSec: number,
	durationSec: number,
): Promise<Float32Array> {
	const { stdout } = await run([
		"-nostdin",
		"-hide_banner",
		"-loglevel",
		"error",
		"-i",
		file,
		"-map",
		"0:a:0",
		// Stereo, then take the left channel. Downmixing to mono is not neutral — this ffmpeg's
		// `-ac 1` sums the two channels at 0.707 each, which reads as +3 dB on a signal that is
		// identical in L and R. Comparing one channel of two stereo decodes cancels every
		// upmix coefficient instead of assuming one.
		"-ac",
		"2",
		"-ar",
		"48000",
		"-f",
		"f32le",
		"-",
	]);
	const interleaved = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
	const frames = Math.floor(interleaved.length / 2);
	const from = Math.min(frames, Math.max(0, Math.round(startSec * 48_000)));
	const count = Math.min(frames - from, Math.round(durationSec * 48_000));
	const mono = new Float32Array(Math.max(0, count));
	for (let i = 0; i < mono.length; i++) mono[i] = interleaved[(from + i) * 2];
	return mono;
}

/** A mono reference decoded as mono: for a mono source this is the sample stream itself. */
async function pcmMono(file: string, startSec: number, durationSec: number): Promise<Float32Array> {
	const { stdout } = await run([
		"-nostdin",
		"-hide_banner",
		"-loglevel",
		"error",
		"-i",
		file,
		"-map",
		"0:a:0",
		"-ac",
		"1",
		"-ar",
		"48000",
		"-f",
		"f32le",
		"-",
	]);
	const all = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
	const from = Math.min(all.length, Math.max(0, Math.round(startSec * 48_000)));
	const count = Math.min(all.length - from, Math.round(durationSec * 48_000));
	return all.subarray(from, from + Math.max(0, count));
}

function rms(samples: Float32Array): number {
	let sum = 0;
	for (const sample of samples) sum += sample * sample;
	return Math.sqrt(sum / Math.max(1, samples.length));
}

const db = (value: number): number => 20 * Math.log10(Math.max(value, 1e-12));

/** The video elementary stream, hashed: proves `-c:v copy` byte-for-byte. */
async function videoPacketHash(file: string): Promise<string> {
	const probe = await run(["-nostdin", "-hide_banner", "-i", file]);
	const codec = /Stream #0:\d+.*: Video: (h264|hevc)/.exec(probe.stderr)?.[1];
	if (!codec) throw new Error(`no video codec in ${file}`);
	const { stdout } = await run([
		"-nostdin",
		"-hide_banner",
		"-loglevel",
		"error",
		"-i",
		file,
		"-map",
		"0:v:0",
		"-c",
		"copy",
		"-f",
		codec,
		"-",
	]);
	return createHash("md5").update(stdout).digest("hex");
}

async function streamInfo(
	file: string,
): Promise<{ codec: string; tag: string; duration: number }[]> {
	const probe = await run(["-nostdin", "-hide_banner", "-i", file]);
	const lines = probe.stderr.split("\n");
	const streams: { codec: string; tag: string; duration: number }[] = [];
	for (const line of lines) {
		const match = /Stream #0:\d+.*: (Video|Audio): ([a-z0-9_]+)/.exec(line);
		if (!match) continue;
		// The container tag is the parenthesised `avc1 / 0x…` pair, which sits after the
		// profile (e.g. `h264 (Constrained Baseline) (avc1 / 0x31637661)`), so it is searched
		// for in the whole line rather than expected at a fixed position.
		const tag = /\((\w+) \/ 0x[0-9a-f]+\)/i.exec(line)?.[1] ?? "";
		streams.push({ codec: match[2], tag, duration: 0 });
	}
	const durationLine = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(probe.stderr);
	const total = durationLine
		? Number(durationLine[1]) * 3600 + Number(durationLine[2]) * 60 + Number(durationLine[3])
		: 0;
	for (const stream of streams) stream.duration = total;
	return streams;
}

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-mix-"));
	fixture = path.join(dir, "bed.mp4");
	if (ffmpeg) await makeVideo(fixture);
}, 120_000);

afterAll(async () => {
	if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe("buildFilterGraph — the old mixer's arithmetic, pinned", () => {
	it("mixes the bed at 0.4 and the voiceover at unity, without amix renormalising", () => {
		const graph = buildFilterGraph({
			hasBed: true,
			mode: "mix",
			offsetSec: 0,
			originalGain: DEFAULT_ORIGINAL_GAIN,
		});
		expect(graph).toContain("volume=0.4");
		expect(graph).toContain("normalize=0");
		// `dropout_transition=0` is NOT set: with normalize=0 it makes the bed drop 3 dB when the
		// voiceover ends. The semantic test below measures that window, so a regression fails here
		// or there.
		expect(graph).not.toContain("dropout_transition");
		expect(graph).toContain("amix=inputs=2:duration=longest");
		// apad keeps the audio at least as long as the video; -shortest then ends with the video.
		expect(graph.endsWith("[vo]apad[aout]") || graph.endsWith(",apad[aout]")).toBe(true);
	});

	it("drops the bed entirely for replace, and for a render with no audio stream", () => {
		for (const options of [
			{ hasBed: true, mode: "replace" as const, offsetSec: 0, originalGain: 0.4 },
			{ hasBed: false, mode: "mix" as const, offsetSec: 0, originalGain: 0.4 },
		]) {
			const graph = buildFilterGraph(options);
			expect(graph).not.toContain("[0:a]");
			expect(graph).not.toContain("amix");
			expect(graph).toContain("[1:a]");
		}
	});

	it("delays the voiceover by the offset, and clamps a negative one to zero", () => {
		const delayed = buildFilterGraph({
			hasBed: true,
			mode: "mix",
			offsetSec: 2.5,
			originalGain: 0.4,
		});
		expect(delayed).toContain("adelay=delays=2500:all=1");
		const clamped = buildFilterGraph({
			hasBed: true,
			mode: "mix",
			offsetSec: -3,
			originalGain: 0.4,
		});
		expect(clamped).not.toContain("adelay");
	});

	it("formats numbers without a locale comma or an exponent", () => {
		const graph = buildFilterGraph({
			hasBed: true,
			mode: "mix",
			offsetSec: 1e-7,
			originalGain: 1 / 3,
		});
		expect(graph).not.toMatch(/\d,\d/);
		expect(graph).not.toMatch(/e-?\d/i);
	});
});

describe("buildMixArgs — the video is copied, never re-encoded", () => {
	const request: VoiceoverMixRequest = {
		renderPath: "C:\\a b\\render-1.mp4",
		voiceoverPath: "C:\\音 轨\\vo.wav",
		outPath: "C:\\a b\\mixed-1.mp4",
		mode: "mix",
		offsetSec: 0,
	};

	it("maps the first video stream with -c:v copy and names no video encoder", () => {
		const args = buildMixArgs(request, true);
		expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual(["-c:v", "copy"]);
		expect(args.join(" ")).not.toMatch(/-c:v (lib|h264|hevc)/);
		expect(args).toContain("-map");
		expect(args[args.indexOf("-map") + 1]).toBe("0:v:0");
	});

	it("keeps each path as one argument, so spaces and CJK never reach a shell", () => {
		const args = buildMixArgs(request, true);
		expect(args).toContain("C:\\a b\\render-1.mp4");
		expect(args).toContain("C:\\音 轨\\vo.wav");
		expect(args.at(-1)).toBe("C:\\a b\\mixed-1.mp4");
		expect(args.some((arg) => arg.includes("&&") || arg.includes("|"))).toBe(false);
	});

	it("encodes AAC at the product's own output shape", () => {
		const args = buildMixArgs(request, true);
		expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
		expect(args[args.indexOf("-b:a") + 1]).toBe("192000");
		expect(args[args.indexOf("-ar") + 1]).toBe("48000");
		expect(args[args.indexOf("-ac") + 1]).toBe("2");
	});
});

describe("mixPartialPath — the name the sweep is allowed to remove", () => {
	it("is a pid-carrying partial beside the output, so a killed mix leaves attributable litter", () => {
		const out = path.join("C:", "clips", "demo.mixed-abcdefgh.mp4");
		const partial = mixPartialPath(out);
		expect(path.dirname(partial)).toBe(path.dirname(out));
		const known = classifyExportTempName(path.basename(partial));
		expect(known?.kind).toBe("encoder-partial");
		expect(known?.pid).toBe(process.pid);
		// And the stage it is destined for is NOT sweepable — which is why this indirection
		// exists at all: a crash must leave something the next export may safely delete.
		expect(classifyExportTempName(path.basename(out))?.kind).toBe("mixed-stage");
	});

	it("is different on every call, so two mixes cannot collide", () => {
		const out = path.join("C:", "clips", "demo.mixed-abcdefgh.mp4");
		expect(mixPartialPath(out)).not.toBe(mixPartialPath(out));
	});
});

describe.skipIf(!ffmpeg)("mixVoiceoverToFile — media semantics", () => {
	it("probes for an audio stream and its channel layout", async () => {
		// The fixture's bed is a mono `sine`, so the probe has to say so: a mono input needs a
		// different up-mix rule from a stereo one, and guessing costs 3 dB.
		expect(await probeAudioStream(ffmpeg as string, fixture)).toEqual({
			hasAudio: true,
			channels: 1,
		});
		const stereo = path.join(dir, "stereo.mp4");
		await makeVideo(stereo, { seconds: 1, withAudio: false });
		const withStereoAudio = path.join(dir, "stereo-audio.mp4");
		await run([
			"-nostdin",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			stereo,
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:sample_rate=48000:duration=1",
			"-af",
			"pan=stereo|c0=c0|c1=c0",
			"-c:v",
			"copy",
			"-c:a",
			"aac",
			"-t",
			"1",
			withStereoAudio,
		]);
		await fs.rename(withStereoAudio, stereo);
		expect(await probeAudioStream(ffmpeg as string, stereo)).toEqual({
			hasAudio: true,
			channels: 2,
		});
		const silent = path.join(dir, "silent.mp4");
		await makeVideo(silent, { withAudio: false });
		expect(await probeAudioStream(ffmpeg as string, silent)).toEqual({
			hasAudio: false,
			channels: null,
		});
	});

	it("keeps a mono voiceover at unity instead of the 3 dB an aformat up-mix costs", async () => {
		// The regression this exists for: `aformat=channel_layouts=stereo` scales a mono input by
		// 0.707 per channel, so a -21.07 dBFS tone came out at -24.09 and the product's own
		// acceptance matrix (0.5 dB tolerance) caught it.
		const voice = path.join(dir, "voice-unity.wav");
		await makeTone(voice, 880, 1);
		const mono = await pcmMono(voice, 0, 0.5);
		const out = path.join(dir, "unity.mp4");
		await mixVoiceoverToFile({
			renderPath: fixture,
			voiceoverPath: voice,
			outPath: out,
			mode: "replace",
			offsetSec: 0,
		});
		const mixed = await pcmWindow(out, 0.2, 0.5);
		expect(db(rms(mixed)) - db(rms(mono))).toBeGreaterThan(-0.5);
		expect(db(rms(mixed)) - db(rms(mono))).toBeLessThan(0.5);
	});

	it("keeps the video packets byte-identical and the video's length", async () => {
		const voice = path.join(dir, "voice-880.wav");
		await makeTone(voice, 880, 1);
		const out = path.join(dir, "mix-basic.mp4");

		const result = await mixVoiceoverToFile({
			renderPath: fixture,
			voiceoverPath: voice,
			outPath: out,
			mode: "mix",
			offsetSec: 1,
		});

		expect(result.hasBed).toBe(true);
		// The partial is renamed onto the stage, never left behind.
		expect((await fs.readdir(dir)).filter((f) => f.includes(".partial-"))).toEqual([]);
		expect(await videoPacketHash(out)).toBe(await videoPacketHash(fixture));
		const info = await streamInfo(out);
		expect(info.map((s) => s.codec)).toEqual(["h264", "aac"]);
		expect(info[0].tag).toBe("avc1");
		expect(info[0].duration).toBeCloseTo(3, 1);
	});

	it("applies 0.4 to the bed, unity to the voiceover, and no step when the voiceover ends", async () => {
		// The fixture's bed is mono, and the mixer now duplicates a mono input at unity rather
		// than applying ffmpeg's 0.707 up-mix — so the reference has to be read the same way.
		const inputBed = await pcmMono(fixture, 0.2, 0.5);
		const voiceFile = path.join(dir, "voice-880.wav");
		const voice = await pcmWindow(voiceFile, 0.1, 0.5);
		const out = path.join(dir, "mix-gain.mp4");

		await mixVoiceoverToFile({
			renderPath: fixture,
			voiceoverPath: voiceFile,
			outPath: out,
			mode: "mix",
			offsetSec: 1,
		});

		// Before the voiceover: the bed alone, ducked by 0.4.
		const before = await pcmWindow(out, 0.2, 0.5);
		// During it: both, summed without renormalisation.
		const during = await pcmWindow(out, 1.1, 0.5);
		// After it (the voiceover ends at 2.0 s): the bed alone again — the point of
		// `normalize=0`, no bump back to unity and no 3 dB step from a dropout transition.
		const after = await pcmWindow(out, 2.2, 0.5);

		expect(db(rms(before)) - db(rms(inputBed) * DEFAULT_ORIGINAL_GAIN)).toBeLessThan(0.5);
		expect(db(rms(after)) - db(rms(before))).toBeLessThan(0.5);
		// Both sources are audible: the sum is louder than the ducked bed alone, and not by a
		// hair — a silent voiceover or a halved bed would both fail this.
		expect(db(rms(during))).toBeGreaterThan(db(rms(before)) + 1);
		expect(db(rms(during))).toBeGreaterThan(db(rms(voice)) - 6);
	});

	it("replace carries the voiceover alone, silent before its offset", async () => {
		const voice = path.join(dir, "voice-replace.wav");
		await makeTone(voice, 880, 1);
		const out = path.join(dir, "replace.mp4");
		await mixVoiceoverToFile({
			renderPath: fixture,
			voiceoverPath: voice,
			outPath: out,
			mode: "replace",
			offsetSec: 1,
		});
		expect(db(rms(await pcmWindow(out, 0.1, 0.5)))).toBeLessThan(-60);
		expect(db(rms(await pcmWindow(out, 1.1, 0.5)))).toBeGreaterThan(-30);
	});

	it("pads a short voiceover with silence instead of shortening the video", async () => {
		const voice = path.join(dir, "voice-short.wav");
		await makeTone(voice, 880, 0.5);
		const out = path.join(dir, "short-voice.mp4");
		await mixVoiceoverToFile({
			renderPath: fixture,
			voiceoverPath: voice,
			outPath: out,
			mode: "mix",
			offsetSec: 0,
		});
		const info = await streamInfo(out);
		expect(info[0].duration).toBeCloseTo(3, 1);
		// After the voiceover stopped (0.5 s), only the ducked bed remains, and it is the same
		// level at the end of the file as just after the voiceover — "padded with silence" here
		// means the bed keeps playing, not that the track gets shorter.
		const early = await pcmWindow(out, 1.0, 0.5);
		const late = await pcmWindow(out, 2.0, 0.5);
		expect(db(rms(late))).toBeLessThan(-25);
		expect(Math.abs(db(rms(late)) - db(rms(early)))).toBeLessThan(0.5);
	});

	it("truncates a long voiceover to the video, never the other way round", async () => {
		const voice = path.join(dir, "voice-long.wav");
		await makeTone(voice, 880, 5);
		const out = path.join(dir, "long-voice.mp4");
		await mixVoiceoverToFile({
			renderPath: fixture,
			voiceoverPath: voice,
			outPath: out,
			mode: "mix",
			offsetSec: 0,
		});
		const info = await streamInfo(out);
		expect(info[0].duration).toBeCloseTo(3, 1);
		expect(await videoPacketHash(out)).toBe(await videoPacketHash(fixture));
	});

	it("mixes a render with no audio at all by using the voiceover only", async () => {
		const silent = path.join(dir, "silent.mp4");
		await makeVideo(silent, { withAudio: false });
		const voice = path.join(dir, "voice-nobed.wav");
		await makeTone(voice, 880, 1);
		const out = path.join(dir, "no-bed.mp4");
		const result = await mixVoiceoverToFile({
			renderPath: silent,
			voiceoverPath: voice,
			outPath: out,
			mode: "mix",
			offsetSec: 0,
		});
		expect(result.hasBed).toBe(false);
		expect(db(rms(await pcmWindow(out, 0.1, 0.5)))).toBeGreaterThan(-30);
	});

	it("takes a 44.1 kHz mono voiceover and still writes 48 kHz stereo", async () => {
		const voice = path.join(dir, "voice-441-mono.wav");
		await makeTone(voice, 880, 1, ["-ac", "1", "-ar", "44100"]);
		const out = path.join(dir, "mono-441.mp4");
		await mixVoiceoverToFile({
			renderPath: fixture,
			voiceoverPath: voice,
			outPath: out,
			mode: "mix",
			offsetSec: 0,
		});
		const { stderr } = await run(["-nostdin", "-hide_banner", "-i", out]);
		expect(stderr).toMatch(/Audio: aac.*48000 Hz, stereo/);
		// The mono tone is the same 880 Hz sine upmixed: its level must survive the conversion.
		expect(db(rms(await pcmWindow(out, 0.5, 0.5)))).toBeGreaterThan(-30);
	});

	it("handles a path with spaces and Chinese characters", async () => {
		const nested = path.join(dir, "音 轨 目录");
		await fs.mkdir(nested, { recursive: true });
		const voice = path.join(nested, "配音 一.wav");
		await makeTone(voice, 880, 1);
		const out = path.join(nested, "混音 结果.mp4");
		await mixVoiceoverToFile({
			renderPath: fixture,
			voiceoverPath: voice,
			outPath: out,
			mode: "mix",
			offsetSec: 0,
		});
		expect((await fs.stat(out)).size).toBeGreaterThan(0);
	});

	it("refuses to write over the render it is reading", async () => {
		await expect(
			mixVoiceoverToFile({
				renderPath: fixture,
				voiceoverPath: fixture,
				outPath: fixture,
				mode: "mix",
				offsetSec: 0,
			}),
		).rejects.toThrow(/overwrite the rendered video/);
	});

	it("fails cleanly on a missing or corrupt voiceover, leaving no output", async () => {
		const out = path.join(dir, "missing-out.mp4");
		await expect(
			mixVoiceoverToFile({
				renderPath: fixture,
				voiceoverPath: path.join(dir, "does-not-exist.wav"),
				outPath: out,
				mode: "mix",
				offsetSec: 0,
			}),
		).rejects.toThrow(/does not exist or is empty/);
		await expect(fs.stat(out)).rejects.toThrow();

		const broken = path.join(dir, "broken.wav");
		await fs.writeFile(broken, Buffer.from("this is not audio"));
		await expect(
			mixVoiceoverToFile({
				renderPath: fixture,
				voiceoverPath: broken,
				outPath: out,
				mode: "mix",
				offsetSec: 0,
			}),
		).rejects.toThrow(/Cannot read media/);
		await expect(fs.stat(out)).rejects.toThrow();
	});
});

describe.skipIf(!ffmpeg)("mixVoiceoverToFile — cancellation", () => {
	it("kills its own child, removes the partial file, and can run again", async () => {
		const longVideo = path.join(dir, "long.mp4");
		const longVoice = path.join(dir, "long-voice.wav");
		await makeVideo(longVideo, { seconds: 120 });
		await makeTone(longVoice, 880, 120);
		const out = path.join(dir, "cancelled.mp4");

		const controller = new AbortController();
		const pending = mixVoiceoverToFile(
			{
				renderPath: longVideo,
				voiceoverPath: longVoice,
				outPath: out,
				mode: "mix",
				offsetSec: 0,
			},
			{ signal: controller.signal },
		);
		setTimeout(() => controller.abort(), 250);
		const error = await pending.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(VoiceoverMixCancelled);
		await expect(fs.stat(out)).rejects.toThrow();
		// Neither the stage nor the partial survive a cancel.
		expect((await fs.readdir(dir)).filter((f) => f.includes("cancelled"))).toEqual([]);

		// The handle is released: the same path can be produced immediately afterwards.
		const again = await mixVoiceoverToFile({
			renderPath: fixture,
			voiceoverPath: longVoice,
			outPath: out,
			mode: "mix",
			offsetSec: 0,
		});
		expect(again.hasBed).toBe(true);
		expect((await fs.stat(out)).size).toBeGreaterThan(0);
	}, 120_000);
});
