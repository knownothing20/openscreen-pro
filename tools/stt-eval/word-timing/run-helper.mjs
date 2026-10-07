// Runs whisper-stt-server over the corpus and saves its raw verbose_json.
// Usage: node run-helper.mjs <tag> <whisper-stt-server.exe> [--cpu] [--condition clean|noisy|both]
//        [--language auto|fr|en] [--only <id substring>] [--env KEY=VAL]
//   -> <data>/results/raw/<tag>/<clipId>.<condition>.json  (+ wallMs)
// Clips already done are skipped, so an interrupted run resumes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLIPS, DATA, RESULTS, startHelper, transcribe } from "./lib.mjs";

const [tag, exe, ...rest] = process.argv.slice(2);
if (!tag || !exe)
	throw new Error(
		"usage: node run-helper.mjs <tag> <whisper-stt-server.exe> [--cpu] [--condition both] [--language auto] [--only <substr>] [--env K=V]",
	);
const flag = (name, dflt) => {
	const i = rest.indexOf(name);
	return i >= 0 ? rest[i + 1] : dflt;
};
const condition = flag("--condition", "both");
const language = flag("--language", "auto"); // the app sends "auto"
const only = flag("--only", "");
const env = { ...process.env };
for (let i = 0; i < rest.length; i++)
	if (rest[i] === "--env") {
		const [k, v] = rest[i + 1].split("=");
		env[k] = v;
	}

const { base, stop } = await startHelper(exe, { cpu: rest.includes("--cpu"), env });
try {
	const outDir = path.join(RESULTS, "raw", tag);
	mkdirSync(outDir, { recursive: true });
	const manifest = JSON.parse(readFileSync(path.join(DATA, "corpus-manifest.json"), "utf8"));
	const conds = condition === "both" ? ["clean", "noisy"] : [condition];
	for (const c of manifest.clips) {
		if (only && !c.id.includes(only)) continue;
		for (const cond of conds) {
			const out = path.join(outDir, `${c.id}.${cond}.json`);
			if (existsSync(out)) continue;
			const wav = path.join(CLIPS, cond === "clean" ? `${c.id}.wav` : `${c.id}.noisy.wav`);
			const { json, wallMs } = await transcribe(base, wav, language);
			writeFileSync(out, JSON.stringify({ ...json, wallMs }));
			console.log(
				`${c.id}.${cond}`,
				`${(wallMs / 1000).toFixed(2)} s`,
				json.detected_language,
				json.backend,
			);
		}
	}
} finally {
	stop();
}
