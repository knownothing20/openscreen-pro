// Puts the edges of every phrase on the speech the helper's VAD found.
//
// The helper times a word from the end of the token before it to the end of its
// own last token (whisper.cpp's t_dtw marks where a token ENDS, see
// whisper-stt/src/main.cpp). Inside continuous speech that lands within ~30 ms
// of the audio (measured on a TTS corpus with exact word times,
// tools/stt-eval/word-timing), so inner boundaries are left alone: an RMS snap
// on top of them would drag correct boundaries early.
//
// The edges of a phrase are the exception. The token before a phrase's first
// word is the previous phrase's last one, so that word "starts" at the end of
// the previous phrase, in the pause, or DTW puts it late when the helper
// starts a new decode window there. Its last word ends on whatever token DTW
// last aligned, short of the speech or past it. When the helper sent its speech
// intervals, both are put on the edges of the stretch of speech they belong to.
//
// That matters because deleting words in the transcript editor trims exactly
// `[firstWord.startSec, lastWord.endSec]`: a late boundary leaves the attack of
// the first removed word audible, an early one bites into the kept word.

import type { SttVadSegment, SttWordSegment } from "./transcriptionContract";

/** A word as the helper reports it: `anchorSec` is always inside the word. */
export interface HelperWord extends SttWordSegment {
	/** End of the word's first token. Only tells which stretch of speech owns the word. */
	anchorSec: number;
}

/** Keep degenerate words non-empty. */
const MIN_WORD_SEC = 0.02;

/**
 * How far a phrase's first word may start after its speech, or its last word
 * end before it, and still be stretched onto that edge — the calibration knob of
 * the anchoring step. Past it, the word is more likely a neighbour of one
 * whisper dropped, and stretching it over that audio would be a guess. Pulling
 * a word forward to the onset, or cutting it back to where the speech stops,
 * needs no such bound: the VAD says nothing is said outside it.
 */
const MAX_ANCHOR_SEC = 1;

/**
 * Audio the helper keeps past each speech offset, as whisper.cpp does, so a soft
 * ending survives. A word whose anchor falls in there belongs to the stretch it
 * trails.
 */
const TAIL_SEC = 0.1;

/** French puts a space before `!`, `?`, `:` and `;`, so whisper emits them as words. */
const isPunctuation = (word: string) => /^[\p{P}\p{S}]+$/u.test(word);

/** An opening bracket or quote starts what follows, so it never closes a sentence. */
const opens = (word: string) => /^[\p{Ps}\p{Pi}]+$/u.test(word);

/** `.`, `!`, `?`, `…` or a full-width form, maybe inside a closing quote or bracket. */
const endsSentence = (text: string) => /[.!?…。！？．｡][\p{Pe}\p{Pf}"']*$/u.test(text);

/** End of the audio the helper kept for stretch `i`: its speech, plus a tail short of the next. */
const keptUntil = (speech: SttVadSegment[], i: number) =>
	Math.min(speech[i].endSec + TAIL_SEC, speech[i + 1]?.startSec ?? Number.POSITIVE_INFINITY);

/**
 * The words each speech stretch owns, as `[from, to)` ranges of `words`: those
 * anchored before the end of the audio the helper kept for it. Both the aligner
 * (ctcAlign.ts) and the edge anchoring below read this, so a word is aligned in
 * the stretch whose edges it is put on.
 *
 * One exception. DTW can anchor a sentence's last word in the pause after it,
 * past the kept tail: the next stretch then put it on its onset, after the
 * words that follow it, and the aligner looked for it in the wrong audio (issue
 * #948). So a word that ends a sentence and is anchored in the pause, before the
 * next stretch's speech, closes the stretch before it, with its punctuation,
 * when that stretch has words. One anchored inside the next speech still opens
 * it: on LibriSpeech, nine one-word sentences ("Heaven!", "What?") open a
 * stretch that way, and giving them to the stretch before cost phrase deletes.
 */
export function ownWords(
	words: ReadonlyArray<{ word: string; anchorSec: number }>,
	speech: SttVadSegment[],
): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	let k = 0;
	for (let i = 0; i < speech.length; i++) {
		const from = k;
		const until = keptUntil(speech, i);
		while (k < words.length && words[k].anchorSec < until) k++;
		// The word that would open the next stretch, and the punctuation after it.
		let first = k;
		while (first < words.length && isPunctuation(words[first].word)) first++;
		let end = first + 1;
		while (end < words.length && isPunctuation(words[end].word) && !opens(words[end].word)) end++;
		if (
			i + 1 < speech.length &&
			first < words.length &&
			words[first].anchorSec < speech[i + 1].startSec &&
			words.slice(from, k).some((w) => !isPunctuation(w.word)) &&
			endsSentence(
				words
					.slice(first, end)
					.map((w) => w.word)
					.join(""),
			)
		)
			k = end;
		out.push([from, k]);
	}
	return out;
}

/**
 * Put the first and last word of every speech stretch on the stretch's edges.
 * The onset already carries the VAD's 30 ms pad, so a cut there lands just
 * before the attack. Words own the speech and no pause: the last word ends on
 * the offset, and the punctuation closing the phrase collapses to a point
 * there, wherever DTW dropped it. Without `speech` (the helper ran without its
 * VAD model), the words come back as the helper timed them.
 */
export function anchorWordsOnSpeech(
	words: HelperWord[],
	speech?: SttVadSegment[],
): SttWordSegment[] {
	const out: SttWordSegment[] = words.map(({ anchorSec: _, ...w }) => ({
		...w,
		endSec: Math.max(w.endSec, w.startSec + MIN_WORD_SEC),
	}));
	if (speech) anchorEdges(out, words, speech);
	// Whatever the stretches did, words come out in order and never inverted. A
	// start past the next word's comes back to it rather than pushing the next
	// one: the onset clamp is what overshoots (a word whisper invented, put on
	// the onset after the real one the aligner found earlier).
	for (let j = out.length - 1; j >= 0; j--) {
		if (j + 1 < out.length) out[j].startSec = Math.min(out[j].startSec, out[j + 1].startSec);
		out[j].endSec = Math.max(out[j].endSec, out[j].startSec);
	}
	return out;
}

function anchorEdges(out: SttWordSegment[], words: HelperWord[], speech: SttVadSegment[]) {
	const owned = ownWords(words, speech);
	for (let i = 0; i < speech.length; i++) {
		const { startSec: onset, endSec: offset } = speech[i];
		let first = -1;
		let last = -1;
		for (let k = owned[i][0]; k < owned[i][1]; k++) {
			if (isPunctuation(out[k].word)) continue;
			if (first < 0) first = k;
			last = k;
		}
		if (first < 0) continue;
		if (out[first].startSec - onset <= MAX_ANCHOR_SEC) {
			out[first].startSec = onset;
			out[first].endSec = Math.max(out[first].endSec, onset + MIN_WORD_SEC);
			for (let j = first - 1; j >= 0 && out[j].endSec > onset; j--) {
				out[j].endSec = onset;
				out[j].startSec = Math.min(out[j].startSec, onset);
			}
		}
		if (offset - out[last].endSec > MAX_ANCHOR_SEC) continue;
		out[last].endSec = Math.max(offset, out[last].startSec + MIN_WORD_SEC);
		for (let j = last + 1; j < out.length && isPunctuation(out[j].word); j++) {
			out[j].startSec = out[last].endSec;
			out[j].endSec = out[last].endSec;
		}
	}
}
