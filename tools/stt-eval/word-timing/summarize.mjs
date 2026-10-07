// Markdown table of evaluated configurations, from <data>/results/<name>.json.
// Usage: node summarize.mjs [<label>=<name>[:<stage>] ...] > summary.md
//   default: the pre-#948 baseline (vk-stock) against the current pipeline (vk-phase1).
//   <stage> is raw, post or post+vad (default).
import { readFileSync } from "node:fs";
import path from "node:path";
import { RESULTS } from "./lib.mjs";

const args = process.argv.slice(2);
const CONFIGS = (args.length ? args : ["Before (shipped)=vk-stock", "Phase 1=vk-phase1"]).map(
	(a) => {
		const [label, spec] = a.split("=");
		const [file, stage = "post+vad"] = spec.split(":");
		return [label, file, stage];
	},
);
const ms = (x) => (x == null ? "-" : (x * 1000).toFixed(0));
const pc = (x) => (x == null ? "-" : `${(x * 100).toFixed(0)}%`);
for (const group of ["all", "clean", "noisy", "clean.fr", "clean.en"]) {
	console.log(`\n**${group}**\n`);
	console.log(
		"| Config | inner start med / P90 / <50 ms | phrase-initial start med / <50 ms | inner end med / <50 ms | phrase-final end med | 1-word delete: clean cuts / audible residue / audible clipping | phrase delete: clean | WER |",
	);
	console.log("|---|---|---|---|---|---|---|---|");
	for (const [label, file, stage] of CONFIGS) {
		let j;
		try {
			j = JSON.parse(readFileSync(path.join(RESULTS, `${file}.json`), "utf8"));
		} catch {
			continue;
		}
		const s = (k) => j.summary[`${group}|${stage}|${k}`];
		const c = (k) => j.counts[`${group}.${k}`];
		const wer = (c("sub") + c("ins") + c("del")) / c("refWords");
		console.log(
			`| ${label} | ${ms(s("start|inner").median)} / ${ms(s("start|inner").p90)} / ${pc(s("start|inner").w50)} | ${ms(s("start|initial").median)} / ${pc(s("start|initial").w50)} | ${ms(s("end|inner").median)} / ${pc(s("end|inner").w50)} | ${ms(s("bias_end|final").median)} (signed) | ${pc(s("trim|clean").mean)} / ${s("trim|residueAudMs").mean.toFixed(0)} ms / ${s("trim|clipAudMs").mean.toFixed(0)} ms | ${pc(s("phrase|clean").mean)} | ${pc(wer)} |`,
		);
	}
}
