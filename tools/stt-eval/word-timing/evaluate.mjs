// Scores helper output against the TTS reference, for each pipeline stage.
// Usage: node evaluate.mjs <tag> [--snap <post-pass.ts>] [--ctc <ctcAlign.ts>] [--out <name>] [--quiet]
//   reads <data>/results/raw/<tag>/*.json, writes <data>/results/<out>.json and
//   <out>.txt, and prints the table.
// Stages:
//   raw      helper words, parsed as whisperServer.ts transcribeImpl does
//   post     the post-pass without speech intervals
//   post+vad the post-pass with the helper's `speech`, as the app runs it
//   ctc      the CTC aligner's times (when run-align.mjs saved emissions)
//   ctc+vad  ctc, then the post-pass with `speech`, as the app runs it with an aligner
// `--snap` swaps the post-pass (default: the repo's snapWordBoundaries.ts), so a
// candidate is scored exactly like the shipped code. It takes the current
// `anchorWordsOnSpeech(words, speech)` or the pre-#948
// `snapWordBoundariesToAudio(words, samples, speech)`, so the old pipeline can
// be scored too (`git show <rev>:electron/stt/snapWordBoundaries.ts`).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { align, CLIPS, envelopeDb, norm, REPO, RESULTS, readWav, stats } from "./lib.mjs";

const [tag, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => {
	const i = rest.indexOf(name);
	return i >= 0 ? rest[i + 1] : dflt;
};
const snapPath = path.resolve(
	flag("--snap", path.join(REPO, "electron/stt/snapWordBoundaries.ts")),
);
const ctcPath = path.resolve(flag("--ctc", path.join(REPO, "electron/stt/ctcAlign.ts")));
const ctc = await import(pathToFileURL(ctcPath).href);
const outName = flag("--out", tag);
const quiet = rest.includes("--quiet");
const mod = await import(pathToFileURL(snapPath).href);
const postPass = mod.anchorWordsOnSpeech
	? (words, _samples, speech) => mod.anchorWordsOnSpeech(words, speech)
	: mod.snapWordBoundariesToAudio;

const PAUSE = 0.1; // reference gap that makes a word phrase-initial / phrase-final
const AUDIBLE_DB = -50; // clean-audio frame energy that counts as audible speech
const CLEAN_MS = 20; // a cut is clean when both audible residue and clipping stay under this
const FRAME = 0.005;
const MS = 1000;

/** Mirrors whisperServer.ts transcribeImpl. */
function parse(json) {
	const toSec = (v, d) => {
		const n = typeof v === "string" ? Number(v) : v;
		return Number.isFinite(n) ? n : d;
	};
	const words = (json.segments ?? [])
		.flatMap((seg) =>
			(seg.words ?? []).map((w) => {
				const word = (w.word ?? "").trim();
				const startSec = toSec(w.start, 0);
				const endSec = toSec(w.end, startSec + 0.05);
				return {
					word,
					startSec,
					endSec: Math.max(startSec + 0.02, endSec),
					anchorSec: toSec(w.anchor, startSec),
				};
			}),
		)
		.filter((w) => w.word.length > 0);
	const speech = json.speech?.map((s) => ({
		startSec: toSec(s.start, 0),
		endSec: toSec(s.end, 0),
	}));
	return { words, speech };
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
/** Audible seconds of [a0, a1]: 5 ms frames of the CLEAN audio above AUDIBLE_DB. */
const audible = (env, a0, a1) => {
	if (a1 <= a0) return 0;
	let n = 0;
	for (
		let f = Math.max(0, Math.floor(a0 / FRAME));
		f < Math.min(env.length, Math.ceil(a1 / FRAME));
		f++
	) {
		if (env[f] > AUDIBLE_DB) n += overlap(a0, a1, f * FRAME, (f + 1) * FRAME);
	}
	return n;
};
/** Seconds of [r0, r1] outside the cut [c0, c1], and the audible part of it. */
const outside = (env, r0, r1, c0, c1) => {
	const segs = [
		[r0, Math.min(r1, c0)],
		[Math.max(r0, c1), r1],
	].filter(([a, b]) => b > a);
	return {
		sec: segs.reduce((s, [a, b]) => s + b - a, 0),
		aud: segs.reduce((s, [a, b]) => s + audible(env, a, b), 0),
	};
};
const inside = (env, r0, r1, c0, c1) => {
	const a = Math.max(r0, c0),
		b = Math.min(r1, c1);
	return b > a ? { sec: b - a, aud: audible(env, a, b) } : { sec: 0, aud: 0 };
};

let STAGES = ["raw", "post", "post+vad"];
const acc = {};
const push = (k, v) => {
	acc[k] ??= [];
	acc[k].push(v);
};
const counts = {};
const inc = (k, v = 1) => (counts[k] = (counts[k] ?? 0) + v);
const perClip = [];
let ctcMs = 0;

const rawDir = path.join(RESULTS, "raw", tag);
for (const file of readdirSync(rawDir)
	.filter((f) => f.endsWith(".json"))
	.sort()) {
	const [id, cond] = file.replace(/\.json$/, "").split(".");
	const json = JSON.parse(readFileSync(path.join(rawDir, file), "utf8"));
	const ref = JSON.parse(readFileSync(path.join(CLIPS, `${id}.ref.json`), "utf8"));
	const samples = readWav(path.join(CLIPS, cond === "clean" ? `${id}.wav` : `${id}.noisy.wav`));
	const env = envelopeDb(readWav(path.join(CLIPS, `${id}.wav`)), FRAME);
	const { words: rawWords, speech } = parse(json);
	const t0 = performance.now();
	const post = postPass(rawWords, samples);
	const full = postPass(rawWords, samples, speech);
	const tsMs = performance.now() - t0;
	const variants = { raw: rawWords, post, "post+vad": full };
	const emissions = json.emissions ? ctc.parseEmissions(json.emissions) : null;
	if (json.emissions && !emissions)
		console.warn(`${file}: unreadable emissions, CTC stages skipped`);
	if (emissions && speech) {
		const t1 = performance.now();
		const aligned = ctc.alignWordsOnEmissions(rawWords, speech, emissions);
		variants.ctc = aligned;
		variants["ctc+vad"] = postPass(aligned, samples, speech);
		ctcMs += performance.now() - t1;
		STAGES = ["raw", "post", "post+vad", "ctc", "ctc+vad"];
	}

	const R = ref.words.map((w, i) => ({ ...w, i, n: norm(w.text) })).filter((w) => w.n);
	const H = rawWords.map((w, j) => ({ j, n: norm(w.word) })).filter((w) => w.n);
	const { pairs, sub, ins, del } = align(
		R.map((w) => w.n),
		H.map((w) => w.n),
	);
	const groups = ["all", cond, `${cond}.${ref.lang}`];
	for (const g of groups) {
		inc(`${g}.refWords`, R.length);
		inc(`${g}.matched`, pairs.length);
		inc(`${g}.sub`, sub);
		inc(`${g}.ins`, ins);
		inc(`${g}.del`, del);
	}
	perClip.push({
		id,
		cond,
		lang: ref.lang,
		audioSec: ref.durationSec,
		helperSec: json.timing?.elapsed_s,
		wallMs: json.wallMs,
		alignSec: json.emissions?.elapsed_s,
		tsMs,
		refWords: R.length,
		matched: pairs.length,
		sub,
		ins,
		del,
	});

	// Phrase position from the reference: a pause (>= PAUSE) before / after the word.
	const pos = R.map((w, k) => ({
		initial: k === 0 || w.start - R[k - 1].end >= PAUSE,
		final: k === R.length - 1 || R[k + 1].start - w.end >= PAUSE,
	}));
	const matchOf = new Map(pairs.map(([ri, hj]) => [ri, H[hj].j]));
	for (const stage of STAGES) {
		const V = variants[stage];
		for (const [ri, hj] of pairs) {
			const r = R[ri];
			const h = V[H[hj].j];
			const ds = h.startSec - r.start;
			const de = h.endSec - r.end;
			const sCls = pos[ri].initial ? "initial" : "inner";
			const eCls = pos[ri].final ? "final" : "inner";
			for (const g of groups) {
				push(`${g}|${stage}|start|all`, Math.abs(ds));
				push(`${g}|${stage}|start|${sCls}`, Math.abs(ds));
				push(`${g}|${stage}|end|all`, Math.abs(de));
				push(`${g}|${stage}|end|${eCls}`, Math.abs(de));
				push(`${g}|${stage}|bias_start|${sCls}`, ds);
				push(`${g}|${stage}|bias_end|${eCls}`, de);
			}
			// Trim: this word deleted alone -> cut [h.start, h.end].
			const res = outside(env, r.start, r.end, h.startSec, h.endSec);
			let clipSec = 0,
				clipAud = 0,
				clipShare = 0;
			for (const k of [ri - 1, ri + 1]) {
				const nb = R[k];
				if (!nb) continue;
				const c = inside(env, nb.start, nb.end, h.startSec, h.endSec);
				clipSec += c.sec;
				clipAud += c.aud;
				clipShare = Math.max(clipShare, c.sec / Math.max(1e-3, nb.end - nb.start));
			}
			for (const g of groups) {
				push(`${g}|${stage}|trim|residueMs`, res.sec * MS);
				push(`${g}|${stage}|trim|residueShare`, res.sec / Math.max(1e-3, r.end - r.start));
				push(`${g}|${stage}|trim|residueAudMs`, res.aud * MS);
				push(`${g}|${stage}|trim|clipMs`, clipSec * MS);
				push(`${g}|${stage}|trim|clipShare`, clipShare);
				push(`${g}|${stage}|trim|clipAudMs`, clipAud * MS);
				push(
					`${g}|${stage}|trim|clean`,
					res.aud * MS <= CLEAN_MS && clipAud * MS <= CLEAN_MS ? 1 : 0,
				);
			}
		}
		// Phrase deletion: every reference phrase (words between two pauses) whose
		// first and last words are matched -> cut [first.start, last.end].
		let k = 0;
		while (k < R.length) {
			let e = k;
			while (!pos[e].final) e++;
			if (matchOf.has(k) && matchOf.has(e)) {
				const c0 = V[matchOf.get(k)].startSec,
					c1 = V[matchOf.get(e)].endSec;
				const res = outside(env, R[k].start, R[e].end, c0, c1);
				let clipAud = 0;
				for (const nb of [R[k - 1], R[e + 1]])
					if (nb) clipAud += inside(env, nb.start, nb.end, c0, c1).aud;
				for (const g of groups) {
					push(`${g}|${stage}|phrase|residueAudMs`, res.aud * MS);
					push(`${g}|${stage}|phrase|clipAudMs`, clipAud * MS);
					push(
						`${g}|${stage}|phrase|clean`,
						res.aud * MS <= CLEAN_MS && clipAud * MS <= CLEAN_MS ? 1 : 0,
					);
				}
			}
			k = e + 1;
		}
	}
}

const summary = {};
for (const [key, xs] of Object.entries(acc)) {
	if (key.includes("|trim|") || key.includes("|phrase|") || key.includes("|bias_")) {
		const a = [...xs].sort((p, q) => p - q);
		summary[key] = {
			n: a.length,
			mean: a.reduce((s, x) => s + x, 0) / a.length,
			median: a[Math.floor(a.length / 2)],
			p90: a[Math.floor(a.length * 0.9)],
		};
	} else summary[key] = stats(xs);
}
writeFileSync(
	path.join(RESULTS, `${outName}.json`),
	JSON.stringify({ tag, snapPath, counts, summary, perClip }, null, 1),
);

// ---- table ----
const f = (x) => (x * MS).toFixed(0).padStart(4);
const g0 = (x) => x.toFixed(0).padStart(4);
const pc = (x) => `${(x * 100).toFixed(0)}%`.padStart(4);
const line = (g, st, what) => {
	const s = summary[`${g}|${st}|${what}`];
	return s?.n
		? `${f(s.mean)} ${f(s.median)} ${f(s.p90)}  ${pc(s.w20)} ${pc(s.w50)} ${pc(s.w100)}  n=${s.n}`
		: "-";
};
const lines = [`# ${outName} (post-pass ${path.basename(snapPath)})`];
for (const g of ["all", "clean", "noisy", "clean.fr", "clean.en", "noisy.fr", "noisy.en"]) {
	if (!counts[`${g}.refWords`]) continue;
	const wer =
		(counts[`${g}.sub`] + counts[`${g}.ins`] + counts[`${g}.del`]) / counts[`${g}.refWords`];
	lines.push(
		`\n=== ${g}: ${counts[`${g}.refWords`]} ref words, matched ${pc(counts[`${g}.matched`] / counts[`${g}.refWords`])}, WER ${pc(wer)} (sub ${counts[`${g}.sub`]} ins ${counts[`${g}.ins`]} del ${counts[`${g}.del`]})`,
	);
	lines.push(`${"".padEnd(28)}mean  med  p90   <20  <50 <100   (ms, |error|)`);
	for (const st of STAGES) {
		const t = (k) => summary[`${g}|${st}|${k}`];
		for (const what of [
			"start|initial",
			"start|inner",
			"end|inner",
			"end|final",
			"start|all",
			"end|all",
		])
			lines.push(`${st.padEnd(10)}${what.padEnd(18)}${line(g, st, what)}`);
		lines.push(
			`${st.padEnd(10)}bias (median signed ms): start initial ${f(t("bias_start|initial").median)} inner ${f(t("bias_start|inner").median)} | end inner ${f(t("bias_end|inner").median)} final ${f(t("bias_end|final").median)}`,
		);
		lines.push(
			`${st.padEnd(10)}1-word delete: residue ${g0(t("trim|residueMs").mean)} ms (audible ${g0(t("trim|residueAudMs").mean)}, p90 ${g0(t("trim|residueAudMs").p90)}), share ${pc(t("trim|residueShare").mean)} | clipping ${g0(t("trim|clipMs").mean)} ms (audible ${g0(t("trim|clipAudMs").mean)}, p90 ${g0(t("trim|clipAudMs").p90)}), share ${pc(t("trim|clipShare").mean)} | clean cuts ${pc(t("trim|clean").mean)}`,
		);
		lines.push(
			`${st.padEnd(10)}phrase delete: audible residue ${g0(t("phrase|residueAudMs").mean)} ms (p90 ${g0(t("phrase|residueAudMs").p90)}), audible clipping ${g0(t("phrase|clipAudMs").mean)} ms (p90 ${g0(t("phrase|clipAudMs").p90)}), clean ${pc(t("phrase|clean").mean)} n=${t("phrase|clean").n}`,
		);
	}
}
const rt = perClip.reduce(
	(a, c) => ({
		audio: a.audio + c.audioSec,
		helper: a.helper + (c.helperSec ?? 0),
		wall: a.wall + c.wallMs / MS,
		ts: a.ts + c.tsMs / MS,
		align: a.align + (c.alignSec ?? 0),
	}),
	{ audio: 0, helper: 0, wall: 0, ts: 0, align: 0 },
);
lines.push(
	`\nruntime: ${perClip.length} clips, ${(rt.audio / 60).toFixed(1)} min audio; helper ${rt.helper.toFixed(1)} s (RTF ${(rt.helper / rt.audio).toFixed(3)}), per clip mean ${(rt.helper / perClip.length).toFixed(2)} s; TS post-pass ${(rt.ts * MS).toFixed(0)} ms total (${((rt.ts * MS) / perClip.length).toFixed(1)} ms/clip, both stages)` +
		(rt.align
			? `; aligner emissions ${rt.align.toFixed(1)} s (+${((100 * rt.align) / rt.helper).toFixed(0)}% of the helper), CTC Viterbi ${ctcMs.toFixed(0)} ms`
			: ""),
);
writeFileSync(path.join(RESULTS, `${outName}.txt`), lines.join("\n") + "\n");
if (!quiet) console.log(lines.join("\n"));
