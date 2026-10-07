// Shared helpers for the word-timing harness: paths, WAV I/O, energy envelope,
// silence runs, reference ends, word normalization and alignment, stats.
// Node stdlib only.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../../..");
/** Corpus, raw helper output and results. Gitignored; OSC_WORD_TIMING_DATA moves it. */
export const DATA = path.resolve(process.env.OSC_WORD_TIMING_DATA ?? path.join(HERE, "data"));
export const CLIPS = path.join(DATA, "clips");
export const RESULTS = path.join(DATA, "results");
export const FFMPEG =
	process.env.FFMPEG ?? path.join(REPO, "electron/native/bin/win32-x64/ffmpeg.exe");
export const MODELS = path.join(
	process.env.APPDATA ?? "",
	"openscreen",
	"stt-models",
	"whisper-ggml",
);
export const SR = 16000;

/**
 * Starts whisper-stt-server with the app's models on a random port in
 * 20500-20599 (OSC_WORD_TIMING_PORT moves the range) and waits until it answers. The process is killed on exit.
 */
export async function startHelper(exe, { cpu = false, env = process.env } = {}) {
	const port = Number(env.OSC_WORD_TIMING_PORT ?? 20500) + Math.floor(Math.random() * 100);
	const args = [
		"--model",
		path.join(MODELS, "ggml-small-q8_0.bin"),
		"--vad-model",
		path.join(MODELS, "ggml-silero-v6.2.0.bin"),
		"--port",
		String(port),
		"--host",
		"127.0.0.1",
		"--threads",
		"16",
		...(cpu ? ["--cpu"] : []),
	];
	const child = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"], env });
	let stderr = "";
	child.stderr.on("data", (d) => {
		stderr = (stderr + d).slice(-4000);
	});
	const stop = () => child.kill();
	process.on("exit", stop);
	process.on("SIGINT", () => process.exit(130));
	const base = `http://127.0.0.1:${port}`;
	for (let t = 0; ; t++) {
		if (child.exitCode !== null) throw new Error(`helper exited ${child.exitCode}: ${stderr}`);
		try {
			if ((await fetch(base)).ok) return { base, stop };
		} catch {
			// not listening yet
		}
		if (t > 600) {
			stop();
			throw new Error(`helper not ready: ${stderr}`);
		}
		await new Promise((r) => setTimeout(r, 200));
	}
}

/** POSTs a WAV to /inference the way the app does (verbose_json, language "auto"). */
export async function transcribe(base, wav, language = "auto") {
	const form = new FormData();
	form.set("file", new Blob([readFileSync(wav)], { type: "audio/wav" }), path.basename(wav));
	form.set("response_format", "verbose_json");
	form.set("language", language);
	const t0 = performance.now();
	const res = await fetch(`${base}/inference`, { method: "POST", body: form });
	const wallMs = performance.now() - t0;
	const json = await res.json();
	if (!res.ok) throw new Error(`${wav}: HTTP ${res.status} ${JSON.stringify(json)}`);
	return { json, wallMs };
}

/** 16-bit PCM mono 16 kHz WAV -> Float32Array in [-1, 1]. Walks chunks. */
export function readWav(file) {
	const b = readFileSync(file);
	let off = 12;
	let fmt = null;
	while (off + 8 <= b.length) {
		const id = b.toString("ascii", off, off + 4);
		const size = b.readUInt32LE(off + 4);
		if (id === "fmt ")
			fmt = {
				channels: b.readUInt16LE(off + 10),
				rate: b.readUInt32LE(off + 12),
				bits: b.readUInt16LE(off + 22),
			};
		if (id === "data") {
			if (!fmt || fmt.channels !== 1 || fmt.bits !== 16 || fmt.rate !== SR)
				throw new Error(`${file}: need 16 kHz mono s16, got ${JSON.stringify(fmt)}`);
			const n = Math.min(size, b.length - off - 8) >> 1;
			const out = new Float32Array(n);
			for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
			return out;
		}
		off += 8 + size + (size & 1);
	}
	throw new Error(`${file}: no data chunk`);
}

/** RMS in dBFS per `frameSec` frame. */
export function envelopeDb(samples, frameSec = 0.005) {
	const L = Math.round(SR * frameSec);
	const n = Math.floor(samples.length / L);
	const out = new Float32Array(n);
	for (let f = 0; f < n; f++) {
		let s = 0;
		for (let i = f * L; i < (f + 1) * L; i++) s += samples[i] * samples[i];
		out[f] = 10 * Math.log10(s / L + 1e-12);
	}
	return out;
}

/** Runs of frames below `thrDb` lasting at least `minSec`: [{ start, end }] seconds. */
export function silenceRuns(env, frameSec, thrDb, minSec) {
	const runs = [];
	let s = -1;
	for (let f = 0; f <= env.length; f++) {
		const quiet = f < env.length && env[f] < thrDb;
		if (quiet && s < 0) s = f;
		if (!quiet && s >= 0) {
			if ((f - s) * frameSec >= minSec) runs.push({ start: s * frameSec, end: f * frameSec });
			s = -1;
		}
	}
	return runs;
}

// Reference ends. SAPI gives them (last non-silent phoneme). OneCore gives only
// starts: a word runs to the next word's start unless a pause (>= MIN_PAUSE of
// energy below THR_DB) sits between them, in which case it ends where the pause
// starts. Checked against SAPI's phoneme ends in validate-ref.mjs.
export const THR_DB = -50;
export const MIN_PAUSE = 0.1;
export function referenceWords(tts, samples) {
	const FRAME = 0.005;
	const runs = silenceRuns(envelopeDb(samples, FRAME), FRAME, THR_DB, MIN_PAUSE);
	const dur = samples.length / SR;
	return tts.words.map((w, i) => {
		const next = tts.words[i + 1]?.start ?? dur;
		const pause = runs.find((r) => r.start > w.start + 0.03 && r.start < next);
		const derivedEnd = pause ? pause.start : next;
		return {
			text: w.text,
			start: w.start,
			end: w.end ?? derivedEnd,
			derivedEnd,
			ttsEnd: w.end ?? null,
		};
	});
}

/** Lowercase, keep letters, digits and inner apostrophes only. */
export function norm(w) {
	return w
		.toLowerCase()
		.normalize("NFC")
		.replace(/[’']/g, "'")
		.replace(/[^\p{L}\p{N}']/gu, "")
		.replace(/^'+|'+$/g, "");
}

/** Levenshtein alignment of two token lists; returns matched pairs [i, j] and sub/ins/del counts. */
export function align(ref, hyp) {
	const n = ref.length;
	const m = hyp.length;
	const W = m + 1;
	const D = new Uint32Array((n + 1) * W);
	const B = new Uint8Array((n + 1) * W); // 0 diag, 1 up (del), 2 left (ins)
	for (let i = 1; i <= n; i++) {
		D[i * W] = i;
		B[i * W] = 1;
	}
	for (let j = 1; j <= m; j++) {
		D[j] = j;
		B[j] = 2;
	}
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			const c = D[(i - 1) * W + j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
			const u = D[(i - 1) * W + j] + 1;
			const l = D[i * W + j - 1] + 1;
			if (c <= u && c <= l) {
				D[i * W + j] = c;
				B[i * W + j] = 0;
			} else if (u <= l) {
				D[i * W + j] = u;
				B[i * W + j] = 1;
			} else {
				D[i * W + j] = l;
				B[i * W + j] = 2;
			}
		}
	}
	const pairs = [];
	let sub = 0,
		ins = 0,
		del = 0;
	let i = n,
		j = m;
	while (i > 0 || j > 0) {
		const b = B[i * W + j];
		if (i > 0 && j > 0 && b === 0) {
			if (ref[i - 1] === hyp[j - 1]) pairs.push([i - 1, j - 1]);
			else sub++;
			i--;
			j--;
		} else if (i > 0 && (j === 0 || b === 1)) {
			del++;
			i--;
		} else {
			ins++;
			j--;
		}
	}
	pairs.reverse();
	return { pairs, sub, ins, del };
}

export function stats(xs) {
	if (xs.length === 0) return { n: 0 };
	const a = [...xs].sort((p, q) => p - q);
	const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
	const mean = a.reduce((s, x) => s + x, 0) / a.length;
	const within = (t) => a.filter((x) => x <= t).length / a.length;
	return {
		n: a.length,
		mean,
		median: q(0.5),
		p90: q(0.9),
		w20: within(0.02),
		w50: within(0.05),
		w100: within(0.1),
	};
}
