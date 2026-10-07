// Builds the synthetic corpus: SSML -> Windows TTS (tts.ps1) -> 16 kHz mono WAV
// + reference word times, plus a degraded copy (pink noise + light reverb).
// Usage: node make-corpus.mjs            (skips clips already on disk)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RENDERS, TEXTS } from "./corpus-texts.mjs";
import { CLIPS, DATA, FFMPEG, HERE, readWav, referenceWords } from "./lib.mjs";

mkdirSync(CLIPS, { recursive: true });

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function ssml(text, lang, rate) {
	const body = text
		.split(/(\{\d+\})/)
		.map((part) => {
			const m = /^\{(\d+)\}$/.exec(part);
			return m ? `<break time="${m[1]}ms"/>` : esc(part);
		})
		.join("");
	// OneCore rejects a <prosody> without attributes: always write the rate.
	const pct = Math.round((rate - 1) * 100);
	const r = ` rate="${pct >= 0 ? "+" : ""}${pct}%"`;
	return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang === "fr" ? "fr-FR" : "en-US"}"><prosody${r}>${body}</prosody></speak>`;
}

function render(id, text, lang, r) {
	const base = path.join(CLIPS, id);
	if (existsSync(`${base}.ref.json`)) return JSON.parse(readFileSync(`${base}.ref.json`, "utf8"));
	const ssmlFile = `${base}.ssml`;
	writeFileSync(ssmlFile, ssml(text, lang, r.rate));
	execFileSync(
		"powershell",
		[
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			path.join(HERE, "tts.ps1"),
			"-Engine",
			r.engine,
			"-Voice",
			r.voice,
			"-SsmlFile",
			ssmlFile,
			"-Out",
			base,
		],
		{ stdio: "inherit" },
	);
	// Canonical 16 kHz mono s16 with a plain header (both engines already emit
	// 16 kHz mono, so this is a container rewrite, no resampling).
	execFileSync(FFMPEG, [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-i",
		`${base}.raw.wav`,
		"-ar",
		"16000",
		"-ac",
		"1",
		"-c:a",
		"pcm_s16le",
		"-map_metadata",
		"-1",
		"-fflags",
		"+bitexact",
		`${base}.wav`,
	]);
	rmSync(`${base}.raw.wav`);
	// Degraded copy: pink noise ~25 dB under the speech, two early reflections.
	execFileSync(FFMPEG, [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-i",
		`${base}.wav`,
		"-filter_complex",
		"[0:a]aecho=0.9:0.6:23|41:0.25|0.15[r];anoisesrc=color=pink:amplitude=0.012:sample_rate=16000:seed=7[n];[r][n]amix=inputs=2:duration=first:normalize=0[o]",
		"-map",
		"[o]",
		"-ar",
		"16000",
		"-ac",
		"1",
		"-c:a",
		"pcm_s16le",
		"-fflags",
		"+bitexact",
		`${base}.noisy.wav`,
	]);
	const tts = JSON.parse(readFileSync(`${base}.tts.json`, "utf8").replace(/^﻿/, ""));
	const samples = readWav(`${base}.wav`);
	const ref = {
		id,
		lang,
		...r,
		durationSec: samples.length / 16000,
		words: referenceWords(tts, samples),
	};
	writeFileSync(`${base}.ref.json`, JSON.stringify(ref, null, 1));
	return ref;
}

const manifest = [];
for (const lang of ["fr", "en"]) {
	TEXTS[lang].forEach((text, i) => {
		for (const r of RENDERS[lang]) {
			const id = `${lang}${i + 1}-${r.voice.split(" ")[1].toLowerCase()}-${Math.round(r.rate * 100)}`;
			const ref = render(id, text, lang, r);
			manifest.push({
				id,
				lang,
				engine: r.engine,
				voice: r.voice,
				rate: r.rate,
				script: i + 1,
				durationSec: ref.durationSec,
				words: ref.words.length,
			});
			console.log(id, ref.durationSec.toFixed(1), "s", ref.words.length, "words");
		}
	});
}
const total = manifest.reduce((s, c) => s + c.durationSec, 0);
writeFileSync(
	path.join(DATA, "corpus-manifest.json"),
	JSON.stringify(
		{ totalSec: total, degraded: "pink noise amplitude 0.012 + aecho 23/41 ms", clips: manifest },
		null,
		1,
	),
);
console.log(`total ${(total / 60).toFixed(1)} min clean (+ the same again degraded)`);
