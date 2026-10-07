// Second alignment pass: re-times whisper's words on a CTC acoustic model
// (issue #948, phase 3).
//
// whisper's DTW times words within ~30 ms median inside continuous speech, but
// its 20 ms frames and diffuse cross-attention cap it there (P90 ~110 ms). A
// wav2vec2 model fine-tuned for CTC scores every 20 ms frame against every
// letter, so a Viterbi pass that forces whisper's own words through those
// scores puts each letter where the audio has it. The helper computes the
// scores (`/emissions`, electron/native/whisper-stt/src/ctc_aligner.cpp); this
// file spells whisper's words in the model's letters, aligns them, and maps the
// letters back to word times.
//
// Words the model cannot spell (digits, symbols, another script) become one
// wildcard token that matches any speech, so they hold their place and their
// neighbours stay aligned. A stretch the model cannot fit keeps the times it
// came with, and so does every word when there is no aligner for the language.
//
// Self-contained on purpose: tools/stt-eval/word-timing imports this file
// straight into Node, which resolves no extensionless import.

import { ownWords } from "./snapWordBoundaries.ts";
import type { SttVadSegment } from "./transcriptionContract";

/** What `/emissions` answers, decoded. */
export interface CtcEmissions {
	vocab: string[];
	blank: number;
	/** Seconds between two frames. */
	strideSec: number;
	/** Per requested region: its first frame's time and `frames * vocab` log-probs. */
	regions: Array<{ startSec: number; frames: number; logprobs: Float32Array }>;
}

/** The fields of a helper word this pass reads and rewrites. */
export interface AlignableWord {
	word: string;
	startSec: number;
	endSec: number;
	/** Always inside the word; decides which stretch of speech owns it. */
	anchorSec: number;
}

// Calibration, fitted on tools/stt-eval/word-timing (TTS and LibriSpeech agree).
// The model is sure of a letter a little after the sound starts and before it
// ends, so CTC shrinks words: the edges move outward. Inside continuous speech
// the word boundary lies between the last letter of one word and the first of
// the next; where the two estimates cross, the boundary is their midpoint.
/** Added to the frame of a word's first letter. */
export const START_OFFSET_SEC = -0.045;
/** Added to the end of the frame of a word's last letter. */
export const END_OFFSET_SEC = 0.025;
/** A gap between two words' letters this long is a pause, not a boundary. */
export const PAUSE_SEC = 0.1;
/** After a pause, a word's first letter trails its onset further (breath, closure, soft attack). */
export const PAUSE_START_OFFSET_SEC = -0.06;
/** Before a pause, a word decays past its last letter; early there is audible, late is silence. */
export const PAUSE_END_OFFSET_SEC = 0.15;

/** Audio kept on each side of a stretch of speech, so its first and last letters have context. */
export const REGION_MARGIN_SEC = 0.3;

/** As in snapWordBoundaries.ts: the audio the helper keeps past each speech offset. */
const TAIL_SEC = 0.1;

const WILDCARD = -1;

/** Seconds of the upload the helper should score: the speech plus a margin, merged. */
export function emissionRegions(
	speech: SttVadSegment[],
	durationSec: number,
): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (const s of speech) {
		const a = Math.max(0, s.startSec - REGION_MARGIN_SEC);
		const b = Math.min(durationSec, s.endSec + REGION_MARGIN_SEC);
		const last = out[out.length - 1];
		if (last && a <= last[1]) last[1] = Math.max(last[1], b);
		else if (b > a) out.push([a, b]);
	}
	return out;
}

/**
 * A word as the model's token ids: `[]` when there is nothing to say
 * (punctuation), `null` when a letter is not in the vocabulary (digits, symbols,
 * another script). Case follows the vocabulary, an accented letter the
 * vocabulary lacks falls back to its base letter, and the apostrophe is
 * normalised.
 */
export function wordTokens(word: string, index: Map<string, number>): number[] | null {
	const upper = index.has("A") && !index.has("a");
	let text = word.normalize("NFC").replace(/[’‘`´]/g, "'");
	text = upper ? text.toUpperCase() : text.toLowerCase();
	const out: number[] = [];
	for (const ch of text) {
		const id = index.get(ch);
		if (id !== undefined) {
			out.push(id);
			continue;
		}
		if (/\p{S}/u.test(ch)) return null; // "%", "+", "€": said aloud, but not spelled so
		if (/[\p{P}\s]/u.test(ch)) continue; // silent, apostrophes and hyphens included
		const base = [...ch.normalize("NFD").replace(/\p{M}/gu, "")];
		const ids = base.map((c) => index.get(c));
		if (ids.length === 0 || ids.some((x) => x === undefined)) return null;
		out.push(...(ids as number[]));
	}
	return out;
}

/**
 * CTC Viterbi forced alignment of `labels` over `T` frames of `V` log-probs.
 * `WILDCARD` scores as the frame's best non-blank token. Returns, per label, the
 * first and last frame the best path spends on it, or null when the labels
 * cannot fit in the frames.
 */
export function ctcViterbi(
	logprobs: Float32Array,
	T: number,
	V: number,
	blank: number,
	labels: number[],
): Array<[number, number]> | null {
	const L = labels.length;
	const S = 2 * L + 1;
	if (L === 0 || T === 0) return null;
	const wild = new Float32Array(T);
	if (labels.includes(WILDCARD)) {
		for (let t = 0; t < T; t++) {
			let best = Number.NEGATIVE_INFINITY;
			for (let v = 0; v < V; v++) if (v !== blank) best = Math.max(best, logprobs[t * V + v]);
			wild[t] = best;
		}
	}
	const lab = (s: number) => (s % 2 === 0 ? blank : labels[(s - 1) >> 1]);
	const em = (t: number, s: number) => {
		const l = lab(s);
		return l === WILDCARD ? wild[t] : logprobs[t * V + l];
	};
	const NEG = Number.NEGATIVE_INFINITY;
	let prev = new Float64Array(S).fill(NEG);
	let cur = new Float64Array(S);
	const back = new Uint8Array(T * S); // how far back the best predecessor is: 0, 1 or 2
	prev[0] = em(0, 0);
	prev[1] = em(0, 1);
	for (let t = 1; t < T; t++) {
		for (let s = 0; s < S; s++) {
			let best = prev[s];
			let from = 0;
			if (s >= 1 && prev[s - 1] > best) {
				best = prev[s - 1];
				from = 1;
			}
			// A label may follow the one before the blank directly, unless it repeats it.
			if (s >= 2 && s % 2 === 1 && lab(s) !== lab(s - 2) && prev[s - 2] > best) {
				best = prev[s - 2];
				from = 2;
			}
			cur[s] = best === NEG ? NEG : best + em(t, s);
			back[t * S + s] = from;
		}
		[prev, cur] = [cur, prev];
	}
	let s = prev[S - 2] > prev[S - 1] ? S - 2 : S - 1;
	if (prev[s] === NEG) return null;
	const spans: Array<[number, number]> = labels.map(() => [-1, -1]);
	for (let t = T - 1; t >= 0; t--) {
		if (s % 2 === 1) {
			const k = (s - 1) >> 1;
			spans[k][0] = t;
			if (spans[k][1] < 0) spans[k][1] = t;
		}
		s -= back[t * S + s];
	}
	return spans;
}

/**
 * Re-time `words` on `emissions`. Each speech stretch owns the words
 * `ownWords` (snapWordBoundaries.ts) gives it; they are aligned on the frames
 * between the neighbouring stretches, with the vocabulary's word delimiter
 * between words when it has one. Words outside every stretch, stretches the
 * model cannot fit, and a vocabulary with no word in it keep the helper's
 * times. Punctuation collapses onto the end of the word before it.
 */
export function alignWordsOnEmissions<W extends AlignableWord>(
	words: W[],
	speech: SttVadSegment[],
	emissions: CtcEmissions,
): W[] {
	const out = words.map((w) => ({ ...w }));
	const index = new Map(emissions.vocab.map((t, i) => [t, i]));
	const delimiter = index.get("|");
	const V = emissions.vocab.length;
	const { strideSec } = emissions;
	const ranges = ownWords(words, speech);
	for (let i = 0; i < speech.length; i++) {
		const { startSec: onset, endSec: offset } = speech[i];
		const [from, to] = ranges[i];
		const owned = Array.from({ length: to - from }, (_, n) => from + n);
		// A region's frames stop up to one receptive field (25 ms) short of the audio
		// it was cut from, so a stretch that runs to the end of the upload ends
		// past them; two frames of slack keep it. `hi` below stays on the frames.
		const region = emissions.regions.find(
			(r) => r.startSec <= onset && r.startSec + (r.frames + 2) * strideSec >= offset,
		);
		if (!region || owned.length === 0) continue;
		// The frames of this stretch: its margin, stopping at the neighbours' speech.
		const lo = Math.max(
			region.startSec,
			(speech[i - 1]?.endSec ?? Number.NEGATIVE_INFINITY) + TAIL_SEC,
			onset - REGION_MARGIN_SEC,
		);
		const hi = Math.min(
			region.startSec + region.frames * strideSec,
			speech[i + 1]?.startSec ?? Number.POSITIVE_INFINITY,
			offset + REGION_MARGIN_SEC,
		);
		const f0 = Math.max(0, Math.ceil((lo - region.startSec) / strideSec));
		const f1 = Math.min(region.frames, Math.floor((hi - region.startSec) / strideSec));
		if (f1 <= f0) continue;

		const labels: number[] = [];
		const timed: Array<{ j: number; first: number; last: number }> = [];
		for (const j of owned) {
			const toks = wordTokens(out[j].word, index);
			if (toks?.length === 0) continue;
			if (labels.length > 0 && delimiter !== undefined) labels.push(delimiter);
			timed.push({ j, first: labels.length, last: labels.length + (toks?.length ?? 1) - 1 });
			labels.push(...(toks ?? [WILDCARD]));
		}
		const spans = ctcViterbi(
			region.logprobs.subarray(f0 * V, f1 * V),
			f1 - f0,
			V,
			emissions.blank,
			labels,
		);
		if (!spans) continue;
		const at = (f: number) => region.startSec + (f0 + f) * strideSec;
		const s = timed.map((w) => at(spans[w.first][0]));
		const e = timed.map((w) => at(spans[w.last][1] + 1));
		timed.forEach(({ j }, q) => {
			const prevEnd = e[q - 1] ?? Number.NEGATIVE_INFINITY;
			const nextStart = s[q + 1] ?? Number.POSITIVE_INFINITY;
			out[j].startSec =
				s[q] - prevEnd >= PAUSE_SEC
					? Math.max(s[q] + PAUSE_START_OFFSET_SEC, (prevEnd + s[q]) / 2)
					: s[q] + START_OFFSET_SEC;
			out[j].endSec =
				nextStart - e[q] >= PAUSE_SEC
					? Math.min(e[q] + PAUSE_END_OFFSET_SEC, (e[q] + nextStart) / 2)
					: e[q] + END_OFFSET_SEC;
			const before = q > 0 ? out[timed[q - 1].j] : null;
			if (before && before.endSec > out[j].startSec) {
				const mid = (before.endSec + out[j].startSec) / 2;
				before.endSec = mid;
				out[j].startSec = mid;
			}
		});
		for (let n = 1; n < owned.length; n++) {
			const j = owned[n];
			if (timed.some((w) => w.j === j)) continue;
			out[j].startSec = out[owned[n - 1]].endSec;
			out[j].endSec = out[j].startSec;
		}
	}
	return out;
}

/** The helper's `/emissions` JSON. */
export interface EmissionsJson {
	vocab: string[];
	blank: number;
	stride_s: number;
	regions: Array<{ start: number; frames: number; logprobs: string }>;
	/** Seconds the helper spent, model load included. */
	elapsed_s?: number;
}

/** Decodes the helper's `/emissions` JSON; null when it is not one. */
export function parseEmissions(json: EmissionsJson): CtcEmissions | null {
	if (!Array.isArray(json?.vocab) || !Array.isArray(json.regions) || !(json.stride_s > 0))
		return null;
	const V = json.vocab.length;
	const regions: CtcEmissions["regions"] = [];
	for (const r of json.regions) {
		// Copied: a pooled Buffer can start on an offset Float32Array refuses.
		const bytes = Uint8Array.from(Buffer.from(r.logprobs, "base64"));
		if (bytes.byteLength !== r.frames * V * 4) return null;
		regions.push({ startSec: r.start, frames: r.frames, logprobs: new Float32Array(bytes.buffer) });
	}
	return { vocab: json.vocab, blank: json.blank, strideSec: json.stride_s, regions };
}
