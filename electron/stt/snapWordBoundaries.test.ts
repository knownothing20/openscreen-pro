import { describe, expect, it } from "vitest";
import { anchorWordsOnSpeech, type HelperWord, ownWords } from "./snapWordBoundaries";
import type { SttWordSegment } from "./transcriptionContract";

/** A helper word; its anchor defaults to its start, as for a request's first word. */
const word = (
	text: string,
	startSec: number,
	endSec: number,
	anchorSec = startSec,
): HelperWord => ({
	word: text,
	startSec,
	endSec,
	anchorSec,
});
const ms = (sec: number) => Math.round(sec * 1000) / 1000;
const times = (words: SttWordSegment[]) => words.map((w) => [w.word, ms(w.startSec), ms(w.endSec)]);

describe("anchorWordsOnSpeech", () => {
	it("returns the helper's times without speech intervals, minus the anchor", () => {
		const out = anchorWordsOnSpeech([word("a", 1, 1.4, 1.2), word("b", 1.4, 1.4, 1.4)]);
		expect(out).toEqual([
			{ word: "a", startSec: 1, endSec: 1.4 },
			{ word: "b", startSec: 1.4, endSec: 1.42 },
		]);
	});

	it("puts a phrase's first word on its onset whether DTW put it late or early", () => {
		// "Salut" opens the request, so it has no previous token and starts late,
		// on its own first token. "Bah" starts where the previous token ended, at
		// the end of the first phrase: in the pause, before its own speech.
		const words = [
			word("Salut", 2.15, 2.5),
			word("!", 2.5, 2.6, 2.6),
			word("Bah", 2.6, 3.8, 3.61),
			word("voilà", 3.8, 4.35, 4.01),
		];
		const speech = [
			{ startSec: 1.57, endSec: 2.56 },
			{ startSec: 3.36, endSec: 4.35 },
		];
		expect(times(anchorWordsOnSpeech(words, speech))).toEqual([
			["Salut", 1.57, 2.56],
			["!", 2.56, 2.56],
			["Bah", 3.36, 3.8],
			["voilà", 3.8, 4.35],
		]);
	});

	it("ends each phrase's last word where its speech stops, stretched or cut back", () => {
		const words = [
			word("tic,", 1.95, 2.59),
			word("tac", 2.59, 2.79, 2.7),
			word("!", 2.79, 2.9, 2.9),
		];
		const speech = [
			{ startSec: 1.95, endSec: 2.37 },
			{ startSec: 2.59, endSec: 3.04 },
		];
		expect(times(anchorWordsOnSpeech(words, speech))).toEqual([
			["tic,", 1.95, 2.37],
			["tac", 2.59, 3.04],
			["!", 3.04, 3.04],
		]);
	});

	it("leaves an edge alone when the word is too far past it to be that edge", () => {
		// 1.2 s after the onset and 1.1 s before the offset: more likely a neighbour
		// of words whisper dropped than the phrase's own edges.
		const tooFar = [word("w", 2.2, 2.5)];
		expect(times(anchorWordsOnSpeech(tooFar, [{ startSec: 1, endSec: 3.6 }]))).toEqual(
			times(tooFar),
		);
	});

	it("gives a word to the stretch its anchor falls in, the kept tail included", () => {
		// "b" is anchored in the first stretch's 0.1 s tail: it closes that phrase.
		// "c" starts in the first stretch (the previous token's end) but is
		// anchored in the second, so it opens the second.
		const words = [
			word("a", 1, 1.9, 1.5),
			word("b", 1.9, 2.05, 2.05),
			word("c", 2.05, 3.5, 3.2),
			word("d", 3.5, 4, 3.8),
		];
		const speech = [
			{ startSec: 1, endSec: 2 },
			{ startSec: 3, endSec: 4 },
		];
		expect(times(anchorWordsOnSpeech(words, speech))).toEqual([
			["a", 1, 1.9],
			["b", 1.9, 2],
			["c", 3, 3.5],
			["d", 3.5, 4],
		]);
	});

	// Issue #948, measured on a Zira TTS clip: "…as if nothing happened. The
	// transcript…" with speech stopping at 30.59 and resuming at 31.33. DTW
	// anchored "happened." at 30.69, past the first stretch's tail.
	const pause = [
		{ startSec: 28.13, endSec: 30.59 },
		{ startSec: 31.33, endSec: 35.23 },
	];

	it("keeps a sentence's last word in the stretch it closes when DTW anchors it in the pause", () => {
		const words = [
			word("and", 27.97, 28.35, 28.35),
			word("nothing", 29.65, 30.03, 30.03),
			word("happened.", 30.03, 30.69, 30.69),
			word("The", 30.69, 31.47, 31.47),
			word("transcript", 31.47, 32.13, 32.13),
		];
		expect(times(anchorWordsOnSpeech(words, pause))).toEqual([
			["and", 28.13, 28.35],
			["nothing", 29.65, 30.03],
			["happened.", 30.03, 30.59],
			["The", 31.33, 31.47],
			["transcript", 31.47, 32.13],
		]);
		expect(ownWords(words, pause)).toEqual([
			[0, 3],
			[3, 5],
		]);
	});

	it("keeps the punctuation whisper split off a sentence's last word with it", () => {
		const words = [
			word("et", 28.2, 28.4, 28.4),
			word("vraiment", 28.4, 30.69, 30.69),
			word("?", 30.69, 30.7, 30.7),
			word("Oui", 30.7, 31.6, 31.5),
		];
		expect(ownWords(words, pause)).toEqual([
			[0, 3],
			[3, 4],
		]);
	});

	it("does not read an opening bracket after a sentence's last word as part of its end", () => {
		// "b." is anchored in the pause, then whisper split "(" off the next word:
		// "b.(" is no sentence end, so "b." would have opened the next stretch.
		const words = [
			word("a", 28.2, 30.03, 30.03),
			word("b.", 30.03, 30.69, 30.69),
			word("(", 30.69, 31.4, 31.4),
			word("c)", 31.4, 32, 32),
		];
		expect(ownWords(words, pause)).toEqual([
			[0, 2],
			[2, 4],
		]);
	});

	it("lets a one-word sentence open a stretch when it is anchored in its speech", () => {
		const words = [
			word("Agreed?", 28.13, 30.5, 30.4),
			word("Yes.", 30.5, 31.6, 31.5),
			word("Good", 31.6, 32, 32),
		];
		expect(ownWords(words, pause)).toEqual([
			[0, 1],
			[1, 3],
		]);
	});

	it("gives a sentence's last word to the next stretch when the one before has no words", () => {
		const words = [word("Done.", 31, 31.6, 31.2), word("Next", 31.6, 32, 32)];
		expect(ownWords(words, pause)).toEqual([
			[0, 0],
			[0, 2],
		]);
	});

	it("puts the words in order, none inverted, whatever stretch owns them", () => {
		// The aligner-on shape of the report, as the aligner left it when the next
		// stretch owned "happened": a 20 ms word after the pause and "The" earlier.
		const aligned = [
			word("nothing", 29.68, 30.59, 30.03),
			word("happened", 31.33, 31.35, 30.69),
			word("The", 30.69, 31.48, 31.47),
			word("transcript", 31.48, 32.12, 32.13),
		];
		const out = anchorWordsOnSpeech(aligned, pause);
		for (const [j, w] of out.entries()) {
			expect(w.endSec).toBeGreaterThanOrEqual(w.startSec);
			if (j > 0) expect(w.startSec).toBeGreaterThanOrEqual(out[j - 1].startSec);
		}
		expect(out.map((w) => w.word)).toEqual(["nothing", "happened", "The", "transcript"]);
	});
});
