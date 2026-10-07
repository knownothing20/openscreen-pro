// Real-speech corpus for the harness: LibriSpeech test-clean read speech with
// Montreal Forced Aligner word times as the reference (silver labels, about
// 10-20 ms from a human's).
// Usage: OSC_WORD_TIMING_DATA=<another data dir> node make-librispeech.mjs \
//          <LibriSpeech/test-clean> <librispeech_alignments/test-clean> [--max-min 60]
//   -> the same layout as make-corpus.mjs (clips/<id>.wav + <id>.ref.json,
//      corpus-manifest.json), clean condition only, so run-helper.mjs
//      --condition clean, run-align.mjs and evaluate.mjs work unchanged.
// Consecutive utterances of a chapter are joined into clips of up to 40 s, so a
// clip reads like narration: phrases separated by the speaker's own pauses.
// Two clips per speaker (the first chapter), so the corpus spans all 40 voices.
// Sources (CC-BY-4.0, dev-time only, never shipped): https://www.openslr.org/12
// (test-clean.tar.gz) and https://zenodo.org/records/2619474.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLIPS, DATA, FFMPEG, SR } from "./lib.mjs";

const [audioRoot, alignRoot, ...rest] = process.argv.slice(2);
if (!alignRoot)
	throw new Error(
		"usage: node make-librispeech.mjs <LibriSpeech/test-clean> <alignments/test-clean> [--max-min 60]",
	);
const i = rest.indexOf("--max-min");
const maxSec = (i >= 0 ? Number(rest[i + 1]) : 60) * 60;
const CLIP_SEC = 40;
const PER_SPEAKER = 2;

/** Word intervals of a TextGrid's "words" tier; empty text is silence. */
function textGridWords(file) {
	const src = readFileSync(file, "utf8");
	const tier = src.slice(src.indexOf('name = "words"'));
	const end = tier.indexOf("item [2]");
	const body = end > 0 ? tier.slice(0, end) : tier;
	const words = [];
	for (const m of body.matchAll(/xmin = ([\d.]+)\s+xmax = ([\d.]+)\s+text = "([^"]*)"/g)) {
		if (m[3].trim()) words.push({ text: m[3].trim(), start: Number(m[1]), end: Number(m[2]) });
	}
	return words;
}

mkdirSync(CLIPS, { recursive: true });
const clips = [];
let total = 0;
outer: for (const spk of readdirSync(alignRoot).sort()) {
	for (const chap of readdirSync(path.join(alignRoot, spk)).sort()) {
		const utts = readdirSync(path.join(alignRoot, spk, chap))
			.filter((f) => f.endsWith(".TextGrid"))
			.map((f) => f.replace(/\.TextGrid$/, ""))
			.sort();
		let group = [];
		let groupSec = 0;
		const flush = () => {
			if (!group.length) return;
			const id = `ls-${group[0]}`;
			const pcm = [];
			const words = [];
			let at = 0;
			for (const u of group) {
				const raw = execFileSync(
					FFMPEG,
					[
						"-v",
						"error",
						"-i",
						path.join(audioRoot, spk, chap, `${u}.flac`),
						"-ac",
						"1",
						"-ar",
						String(SR),
						"-f",
						"s16le",
						"-",
					],
					{ maxBuffer: 1 << 28 },
				);
				for (const w of textGridWords(path.join(alignRoot, spk, chap, `${u}.TextGrid`)))
					words.push({ text: w.text, start: at + w.start, end: at + w.end });
				pcm.push(raw);
				at += raw.length / 2 / SR;
			}
			const data = Buffer.concat(pcm);
			const header = Buffer.alloc(44);
			header.write("RIFF", 0);
			header.writeUInt32LE(36 + data.length, 4);
			header.write("WAVEfmt ", 8);
			header.writeUInt32LE(16, 16);
			header.writeUInt16LE(1, 20);
			header.writeUInt16LE(1, 22);
			header.writeUInt32LE(SR, 24);
			header.writeUInt32LE(SR * 2, 28);
			header.writeUInt16LE(2, 32);
			header.writeUInt16LE(16, 34);
			header.write("data", 36);
			header.writeUInt32LE(data.length, 40);
			writeFileSync(path.join(CLIPS, `${id}.wav`), Buffer.concat([header, data]));
			writeFileSync(
				path.join(CLIPS, `${id}.ref.json`),
				JSON.stringify({ id, lang: "en", engine: "mfa", durationSec: at, words }, null, 1),
			);
			clips.push({ id, lang: "en", durationSec: at, words: words.length });
			total += at;
			console.log(id, at.toFixed(1), "s", words.length, "words");
			group = [];
			groupSec = 0;
		};
		const before = clips.length;
		for (const u of utts) {
			if (clips.length - before >= PER_SPEAKER) break;
			const w = textGridWords(path.join(alignRoot, spk, chap, `${u}.TextGrid`));
			const sec = w.length ? w[w.length - 1].end + 0.3 : 0;
			if (groupSec + sec > CLIP_SEC) flush();
			group.push(u);
			groupSec += sec;
		}
		if (clips.length - before < PER_SPEAKER) flush();
		if (total >= maxSec) break outer;
		break;
	}
}
writeFileSync(
	path.join(DATA, "corpus-manifest.json"),
	JSON.stringify({ totalSec: total, source: "LibriSpeech test-clean + MFA", clips }, null, 1),
);
console.log(`${clips.length} clips, ${(total / 60).toFixed(1)} min`);
