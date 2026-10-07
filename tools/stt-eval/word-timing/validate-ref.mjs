// How good is the TTS reference? Checks it against the audio it describes.
//  1. Onsets: after every pause (>= 150 ms below -50 dBFS), the next reference
//     word should start where the energy comes back. Signed: negative = the
//     reference starts before the audible onset (a stop closure, silent by nature).
//  2. Offsets (SAPI only, where ends come from phonemes, independent of energy):
//     the word before a pause should end where the energy drops.
//  3. OneCore ends are derived (next start, or pause start). The same derivation
//     applied to SAPI clips is compared with SAPI's phoneme ends.
// Usage: node validate-ref.mjs  -> results/ref-validation.json + summary on stdout
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLIPS, DATA, envelopeDb, RESULTS, readWav, silenceRuns, stats } from "./lib.mjs";

const manifest = JSON.parse(readFileSync(path.join(DATA, "corpus-manifest.json"), "utf8"));
const out = {
	onset: { onecore: [], sapi: [] },
	offsetSapi: [],
	derivedVsPhonemeSapi: [],
	derivedVsPhonemeSapiAtPause: [],
};
for (const c of manifest.clips) {
	const ref = JSON.parse(readFileSync(path.join(CLIPS, `${c.id}.ref.json`), "utf8"));
	const env = envelopeDb(readWav(path.join(CLIPS, `${c.id}.wav`)), 0.005);
	const runs = silenceRuns(env, 0.005, -50, 0.15);
	for (const r of runs) {
		const after = ref.words.find((w) => w.start >= r.start - 0.05);
		if (after && after.start < r.end + 0.2) out.onset[c.engine].push(after.start - r.end);
		const before = [...ref.words].reverse().find((w) => w.start < r.start);
		if (c.engine === "sapi" && before?.ttsEnd != null && r.start > 0.01)
			out.offsetSapi.push(before.ttsEnd - r.start);
	}
	if (c.engine === "sapi") {
		for (const w of ref.words) {
			if (w.ttsEnd == null) continue;
			out.derivedVsPhonemeSapi.push(w.derivedEnd - w.ttsEnd);
			if (runs.some((r) => r.start >= w.start && r.start <= w.derivedEnd + 0.01))
				out.derivedVsPhonemeSapiAtPause.push(w.derivedEnd - w.ttsEnd);
		}
	}
}
const signed = (xs) => {
	const a = [...xs].sort((p, q) => p - q);
	const q = (p) => +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(3);
	return { n: a.length, p10: q(0.1), median: q(0.5), p90: q(0.9), abs: stats(xs.map(Math.abs)) };
};
const summary = {
	onset_onecore: signed(out.onset.onecore),
	onset_sapi: signed(out.onset.sapi),
	offset_sapi: signed(out.offsetSapi),
	derivedEnd_minus_phonemeEnd_sapi_all: signed(out.derivedVsPhonemeSapi),
	derivedEnd_minus_phonemeEnd_sapi_at_pause: signed(out.derivedVsPhonemeSapiAtPause),
};
mkdirSync(RESULTS, { recursive: true });
writeFileSync(
	path.join(RESULTS, "ref-validation.json"),
	JSON.stringify({ summary, raw: out }, null, 1),
);
for (const [k, v] of Object.entries(summary)) {
	console.log(
		k.padEnd(44),
		`n=${v.n} p10=${v.p10} med=${v.median} p90=${v.p90} |abs| med=${v.abs.median?.toFixed(3)} w20=${(v.abs.w20 * 100).toFixed(0)}% w50=${(v.abs.w50 * 100).toFixed(0)}%`,
	);
}
