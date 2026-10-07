import { describe, expect, it } from "vitest";
import {
	type AlignableWord,
	alignWordsOnEmissions,
	type CtcEmissions,
	ctcViterbi,
	END_OFFSET_SEC,
	emissionRegions,
	PAUSE_END_OFFSET_SEC,
	PAUSE_START_OFFSET_SEC,
	parseEmissions,
	START_OFFSET_SEC,
	wordTokens,
} from "./ctcAlign";

const VOCAB = ["<pad>", "|", "a", "b", "c", "é", "'"];
const index = new Map(VOCAB.map((t, i) => [t, i]));
const id = (t: string) => index.get(t) as number;

/** Log-probs where frame t is sure of `tokens[t]` (a vocab entry, "" for blank). */
function logprobs(tokens: string[]): Float32Array {
	const V = VOCAB.length;
	const out = new Float32Array(tokens.length * V).fill(-12);
	tokens.forEach((t, f) => {
		out[f * V + (t ? id(t) : 0)] = -0.01;
	});
	return out;
}

const STRIDE = 0.02;
const emissions = (tokens: string[], startSec = 0): CtcEmissions => ({
	vocab: VOCAB,
	blank: 0,
	strideSec: STRIDE,
	regions: [{ startSec, frames: tokens.length, logprobs: logprobs(tokens) }],
});
/** `n` blank frames. */
const gap = (n: number) => Array<string>(n).fill("");
const word = (
	text: string,
	startSec: number,
	endSec: number,
	anchorSec = startSec,
): AlignableWord => ({
	word: text,
	startSec,
	endSec,
	anchorSec,
});
const r = (x: number) => Math.round(x * 1000) / 1000;

describe("wordTokens", () => {
	it("spells a word in the vocabulary's case, dropping silent punctuation", () => {
		const upper = new Map(["<pad>", "|", "A", "B", "C", "'"].map((t, i) => [t, i]));
		expect(wordTokens("Cab,", upper)).toEqual([4, 2, 3]);
		expect(wordTokens("ab’c", upper)).toEqual([2, 3, 5, 4]);
		expect(wordTokens("cab", index)).toEqual([id("c"), id("a"), id("b")]);
	});

	it("keeps an accented letter the vocabulary has and strips the accent otherwise", () => {
		expect(wordTokens("É", index)).toEqual([id("é")]);
		expect(wordTokens("àbc", index)).toEqual([id("a"), id("b"), id("c")]);
	});

	it("gives nothing to say for punctuation, and no spelling for digits and symbols", () => {
		expect(wordTokens("?", index)).toEqual([]);
		expect(wordTokens("...", index)).toEqual([]);
		expect(wordTokens("1080p", index)).toBeNull();
		expect(wordTokens("€", index)).toBeNull();
		expect(wordTokens("日本", index)).toBeNull();
	});
});

describe("ctcViterbi", () => {
	it("finds the frames each label is spoken on", () => {
		const tokens = ["", "a", "a", "", "b", ""];
		expect(ctcViterbi(logprobs(tokens), 6, VOCAB.length, 0, [id("a"), id("b")])).toEqual([
			[1, 2],
			[4, 4],
		]);
	});

	it("needs a blank between two repeats of a label, and fails when the frames are too few", () => {
		const aba = logprobs(["a", "", "a"]);
		expect(ctcViterbi(aba, 3, VOCAB.length, 0, [id("a"), id("a")])).toEqual([
			[0, 0],
			[2, 2],
		]);
		expect(ctcViterbi(logprobs(["a", "a"]), 2, VOCAB.length, 0, [id("a"), id("a")])).toBeNull();
	});

	it("scores a wildcard as whatever is spoken", () => {
		const spans = ctcViterbi(logprobs(["a", "", "c", "c", "", "b"]), 6, VOCAB.length, 0, [
			id("a"),
			-1,
			id("b"),
		]);
		expect(spans?.[1]).toEqual([2, 3]);
	});
});

describe("emissionRegions", () => {
	it("pads each stretch of speech and merges the ones that touch", () => {
		expect(
			emissionRegions(
				[
					{ startSec: 0.1, endSec: 1 },
					{ startSec: 1.4, endSec: 2 },
					{ startSec: 5, endSec: 6 },
				],
				6.1,
			).map(([a, b]) => [r(a), r(b)]),
		).toEqual([
			[0, 2.3],
			[4.7, 6.1],
		]);
	});
});

describe("alignWordsOnEmissions", () => {
	const speech = [{ startSec: 0.2, endSec: 1 }];

	it("times words on their letters, calibrated outward, meeting mid-way inside speech", () => {
		// "ab" on frames 20-21, the delimiter on 22, "c" on 24: continuous speech.
		const tokens = [...gap(20), "a", "b", "|", "", "c", ...gap(40)];
		const out = alignWordsOnEmissions(
			[word("ab", 0.3, 0.5, 0.45), word("c", 0.5, 0.7, 0.6)],
			speech,
			emissions(tokens),
		);
		const abEnd = 22 * STRIDE + END_OFFSET_SEC;
		const cStart = 24 * STRIDE + START_OFFSET_SEC;
		const boundary = abEnd > cStart ? (abEnd + cStart) / 2 : null;
		expect(r(out[0].startSec)).toBe(r(20 * STRIDE + PAUSE_START_OFFSET_SEC));
		expect(r(out[0].endSec)).toBe(r(boundary ?? abEnd));
		expect(r(out[1].startSec)).toBe(r(boundary ?? cStart));
		expect(r(out[1].endSec)).toBe(r(25 * STRIDE + PAUSE_END_OFFSET_SEC));
		expect(out[0].anchorSec).toBe(0.45);
	});

	it("keeps a pause between two words as a pause", () => {
		// "a" on frame 12, "c" on frame 40: 0.54 s apart.
		const tokens = [...gap(12), "a", ...gap(27), "c", ...gap(40)];
		const out = alignWordsOnEmissions(
			[word("a", 0.2, 0.4, 0.3), word("c", 0.4, 0.9, 0.85)],
			speech,
			emissions(tokens),
		);
		expect(r(out[0].endSec)).toBe(r(13 * STRIDE + PAUSE_END_OFFSET_SEC));
		expect(r(out[1].startSec)).toBe(r(40 * STRIDE + PAUSE_START_OFFSET_SEC));
	});

	it("gives a word it cannot spell the speech between its neighbours", () => {
		const tokens = [...gap(15), "a", "|", "c", "b", "c", "|", "b", ...gap(40)];
		const out = alignWordsOnEmissions(
			[word("a", 0.3, 0.32, 0.31), word("42", 0.32, 0.4, 0.35), word("b", 0.4, 0.5, 0.42)],
			speech,
			emissions(tokens),
		);
		expect(out[1].startSec).toBeGreaterThanOrEqual(out[0].endSec);
		expect(out[1].endSec).toBeLessThanOrEqual(out[2].startSec);
		expect(r(out[1].startSec)).toBeLessThan(0.34);
		expect(r(out[2].startSec)).toBeLessThan(0.42);
	});

	it("puts punctuation on the end of the word before it", () => {
		const tokens = [...gap(15), "a", "b", ...gap(40)];
		const out = alignWordsOnEmissions(
			[word("ab", 0.3, 0.5, 0.35), word("!", 0.5, 0.6, 0.55)],
			speech,
			emissions(tokens),
		);
		expect(out[1].startSec).toBe(out[0].endSec);
		expect(out[1].endSec).toBe(out[0].endSec);
	});

	it("aligns a stretch that runs to the end of the upload, past the last frame", () => {
		// 1 s of audio gives 49 frames (0.98 s): the stretch ends after them.
		const tokens = [...gap(30), "a", "b", ...gap(17)];
		const out = alignWordsOnEmissions(
			[word("ab", 0.65, 1, 0.7)],
			[{ startSec: 0.5, endSec: 1 }],
			emissions(tokens),
		);
		expect(r(out[0].startSec)).toBe(r(30 * STRIDE + PAUSE_START_OFFSET_SEC));
	});

	it("aligns a sentence's last word in the stretch it closes, even anchored in the pause", () => {
		// "b." is said on frame 25 (0.5 s), but DTW anchored it at 0.75 s, past the
		// first stretch's tail (issue #948). It is aligned there, not in "c"'s audio.
		const tokens = [...gap(15), "a", "|", ...gap(8), "b", ...gap(49), "c", ...gap(24)];
		const out = alignWordsOnEmissions(
			[word("a", 0.25, 0.35, 0.3), word("b.", 0.35, 0.75, 0.75), word("c", 0.75, 1.6, 1.55)],
			[
				{ startSec: 0.2, endSec: 0.6 },
				{ startSec: 1.4, endSec: 1.8 },
			],
			emissions(tokens),
		);
		expect(r(out[1].startSec)).toBe(r(25 * STRIDE + PAUSE_START_OFFSET_SEC));
		expect(r(out[2].startSec)).toBe(r(75 * STRIDE + PAUSE_START_OFFSET_SEC));
	});

	it("keeps the helper's times where it cannot align", () => {
		const words = [word("ab", 0.3, 0.5, 0.35), word("c", 1.5, 1.7, 1.6)];
		// The second word is outside every stretch; the first one's letters do not fit.
		const out = alignWordsOnEmissions(words, speech, emissions(gap(2)));
		expect(out).toEqual(words);
		// No region covers the stretch at all.
		expect(alignWordsOnEmissions(words, speech, emissions(gap(60), 5))).toEqual(words);
	});
});

describe("parseEmissions", () => {
	const floats = new Float32Array([-0.1, -2, -3, -4, -5, -6, -7]);
	const logprobs = Buffer.from(floats.buffer).toString("base64");

	it("decodes the helper's base64 log-probs", () => {
		const parsed = parseEmissions({
			vocab: VOCAB,
			blank: 0,
			stride_s: 0.02,
			regions: [{ start: 1.5, frames: 1, logprobs }],
		});
		expect(parsed?.regions[0].startSec).toBe(1.5);
		expect([...(parsed?.regions[0].logprobs ?? [])]).toEqual([...floats]);
	});

	it("refuses a reply whose sizes do not add up", () => {
		expect(
			parseEmissions({
				vocab: VOCAB,
				blank: 0,
				stride_s: 0.02,
				regions: [{ start: 0, frames: 2, logprobs }],
			}),
		).toBeNull();
	});
});
