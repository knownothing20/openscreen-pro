// Adds the CTC aligner's emissions to helper responses already saved by
// run-helper.mjs, so evaluate.mjs can score the aligner without re-running whisper.
// Usage: node run-align.mjs <from-tag> <to-tag> <whisper-stt-server.exe> \
//          --model en=<w2v-en.gguf> --model fr=<w2v-fr.gguf> [--cpu] [--only <substr>]
//   reads  <data>/results/raw/<from-tag>/*.json (needs `speech`: run with the VAD model)
//   writes <data>/results/raw/<to-tag>/*.json with `emissions` (the /emissions answer
//          + wallMs) next to the /inference answer
// The helper is started once and asked like the app does (electron/stt/index.ts):
// the regions come from emissionRegions(), the model from the detected language.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { emissionRegions } from "../../../electron/stt/ctcAlign.ts";
import { CLIPS, RESULTS, readWav, SR, startHelper } from "./lib.mjs";

const [fromTag, toTag, exe, ...rest] = process.argv.slice(2);
if (!exe)
	throw new Error(
		"usage: node run-align.mjs <from-tag> <to-tag> <exe> --model en=<gguf> [--model fr=<gguf>] [--cpu] [--only <substr>]",
	);
const models = {};
let only = "";
for (let i = 0; i < rest.length; i++) {
	if (rest[i] === "--model") {
		const [lang, file] = rest[++i].split("=");
		models[lang] = path.resolve(file);
	}
	if (rest[i] === "--only") only = rest[++i];
}

const { base, stop } = await startHelper(exe, { cpu: rest.includes("--cpu") });
try {
	const inDir = path.join(RESULTS, "raw", fromTag);
	const outDir = path.join(RESULTS, "raw", toTag);
	mkdirSync(outDir, { recursive: true });
	for (const file of readdirSync(inDir).filter((f) => f.endsWith(".json"))) {
		if (only && !file.includes(only)) continue;
		const out = path.join(outDir, file);
		if (existsSync(out)) continue;
		const json = JSON.parse(readFileSync(path.join(inDir, file), "utf8"));
		const model = models[json.detected_language];
		if (!model || !json.speech) {
			writeFileSync(out, JSON.stringify(json));
			continue;
		}
		const [id, cond] = file.replace(/\.json$/, "").split(".");
		const wav = path.join(CLIPS, cond === "clean" ? `${id}.wav` : `${id}.noisy.wav`);
		const bytes = readFileSync(wav);
		const durationSec = readWav(wav).length / SR;
		const speech = json.speech.map((s) => ({ startSec: s.start, endSec: s.end }));
		const form = new FormData();
		form.set("file", new Blob([bytes], { type: "audio/wav" }), path.basename(wav));
		form.set("model", model);
		form.set("regions", JSON.stringify(emissionRegions(speech, durationSec)));
		const t0 = performance.now();
		const res = await fetch(`${base}/emissions`, { method: "POST", body: form });
		const wallMs = performance.now() - t0;
		const emissions = await res.json();
		if (!res.ok) throw new Error(`${file}: HTTP ${res.status} ${JSON.stringify(emissions)}`);
		writeFileSync(out, JSON.stringify({ ...json, emissions: { ...emissions, wallMs } }));
		console.log(file, `${emissions.elapsed_s.toFixed(3)} s on ${emissions.device}`);
	}
} finally {
	stop();
}
