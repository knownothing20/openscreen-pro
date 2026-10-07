// Sanity check on real speech, which has no ground truth: the VAD onset is the
// only boundary we can trust there.
// Usage: node real-check.mjs <whisper-stt-server.exe> <take.wav> [--cpu] [--snap <post-pass.ts>]
//          [--align <aligner.gguf>]
//   (16 kHz mono s16 WAV, e.g. ffmpeg -i take.webm -ar 16000 -ac 1 take.wav)
// Prints how far each word's first-token time (`anchor`) lies after its start
// (the one-token lag the helper corrects), and, per VAD stretch, where its first
// word starts relative to the onset: as the helper reports it, and after the
// post-pass. With `--align`, the CTC aligner (electron/stt/ctcAlign.ts) runs too,
// and every word is listed with both times so the boundaries can be checked by
// ear or on a spectrogram. Writes the raw response (and the aligner's words) to
// <data>/results/real-<take>.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	alignWordsOnEmissions,
	emissionRegions,
	parseEmissions,
} from "../../../electron/stt/ctcAlign.ts";
import { REPO, RESULTS, readWav, SR, startHelper, transcribe } from "./lib.mjs";

const [exe, wav, ...rest] = process.argv.slice(2);
if (!exe || !wav)
	throw new Error(
		"usage: node real-check.mjs <whisper-stt-server.exe> <take.wav> [--cpu] [--snap <post-pass.ts>] [--align <aligner.gguf>]",
	);
const flag = (name) => {
	const i = rest.indexOf(name);
	return i >= 0 ? rest[i + 1] : undefined;
};
const snapPath = path.resolve(
	flag("--snap") ?? path.join(REPO, "electron/stt/snapWordBoundaries.ts"),
);
const alignModel = flag("--align") && path.resolve(flag("--align"));
const { anchorWordsOnSpeech } = await import(pathToFileURL(snapPath).href);

const { base, stop } = await startHelper(exe, { cpu: rest.includes("--cpu") });
let json;
let emissions;
try {
	({ json } = await transcribe(base, wav));
	if (alignModel) {
		const speech = json.speech.map((s) => ({ startSec: s.start, endSec: s.end }));
		const form = new FormData();
		form.set("file", new Blob([readFileSync(wav)], { type: "audio/wav" }), path.basename(wav));
		form.set("model", alignModel);
		form.set("regions", JSON.stringify(emissionRegions(speech, readWav(wav).length / SR)));
		const res = await fetch(`${base}/emissions`, { method: "POST", body: form });
		emissions = await res.json();
		if (!res.ok) throw new Error(`/emissions: HTTP ${res.status} ${JSON.stringify(emissions)}`);
	}
} finally {
	stop();
}

const isP = (w) => /^[\p{P}\p{S}]+$/u.test(w.word);
const raw = json.segments
	.flatMap((s) => s.words)
	.map((w) => ({
		word: w.word.trim(),
		startSec: w.start,
		endSec: Math.max(w.start + 0.02, w.end),
		anchorSec: w.anchor ?? w.start,
	}))
	.filter((w) => w.word);
const speech = json.speech.map((s) => ({ startSec: s.start, endSec: s.end }));
const post = anchorWordsOnSpeech(raw, speech);
const parsed = emissions ? parseEmissions(emissions) : null;
if (emissions && !parsed)
	throw new Error("/emissions answered something that is not letter scores (vocab/regions/sizes)");
const aligned = parsed
	? anchorWordsOnSpeech(alignWordsOnEmissions(raw, speech, parsed), speech)
	: null;
mkdirSync(RESULTS, { recursive: true });
writeFileSync(
	path.join(RESULTS, `real-${path.basename(wav, ".wav")}.json`),
	JSON.stringify({ ...json, phase1: post, aligned }),
);

const lag = raw
	.filter((w) => !isP(w))
	.map((w) => w.anchorSec - w.startSec)
	.sort((a, b) => a - b);
const q = (p) => (lag[Math.floor(lag.length * p)] * 1000).toFixed(0);
console.log(
	`${json.detected_language}, ${raw.length} words; first-token time minus start: median ${q(0.5)} ms, p10 ${q(0.1)}, p90 ${q(0.9)}`,
);
const ms = (x) => `${x >= 0 ? "+" : ""}${(x * 1000).toFixed(0)} ms`;
let k = 0;
for (const [i, s] of speech.entries()) {
	const tail = Math.min(s.endSec + 0.1, speech[i + 1]?.startSec ?? Number.POSITIVE_INFINITY);
	while (k < raw.length && isP(raw[k])) k++;
	if (k >= raw.length || raw[k].anchorSec >= tail) continue;
	console.log(
		`stretch ${s.startSec.toFixed(2)}-${s.endSec.toFixed(2)}: "${raw[k].word}" starts ${ms(raw[k].startSec - s.startSec)} from the onset raw, ${ms(post[k].startSec - s.startSec)} after the post-pass`,
	);
	while (k < raw.length && raw[k].anchorSec < tail) k++;
}
if (aligned) {
	const moved = [];
	console.log("\nword                 DTW (s)            aligner (s)        start / end moved");
	raw.forEach((w, j) => {
		const a = post[j];
		const b = aligned[j];
		if (!isP(w)) moved.push(Math.abs(b.startSec - a.startSec), Math.abs(b.endSec - a.endSec));
		console.log(
			`${w.word.padEnd(20)} ${a.startSec.toFixed(3)}-${a.endSec.toFixed(3)}  ${b.startSec.toFixed(3)}-${b.endSec.toFixed(3)}  ${ms(b.startSec - a.startSec)} / ${ms(b.endSec - a.endSec)}`,
		);
	});
	moved.sort((x, y) => x - y);
	const m = (p) => (moved[Math.floor(moved.length * p)] * 1000).toFixed(0);
	const spread = moved.length
		? `median ${m(0.5)} ms, p90 ${m(0.9)} ms`
		: "no word to compare (punctuation only)";
	console.log(
		`\naligner vs DTW, |moved| per boundary: ${spread} (${emissions.elapsed_s.toFixed(2)} s on ${emissions.device})`,
	);
}
