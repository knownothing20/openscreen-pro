// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import {
	AUDIO_NUDGE_START_SEC,
	AUDIO_NUDGE_STOP_SEC,
	AUDIO_SEEK_LEASH_SEC,
	IMPORTED_AUDIO_PLAYING_LEASH_SEC,
	shouldResyncAudio,
	steerAudio,
	type VideoSource,
	VirtualPreview,
} from "./VirtualPreview";

// The root cause of issue #395, in a test.
//
// Dragging the playhead publishes a new time every rAF, the shell mints a
// seekTarget per publish, and this component used to turn each one into a
// `currentTime` write — ~60 demuxer seeks a second on a 1080p H.264 file the
// native compositor is decoding at the same time. Chromium eventually fails
// one (`PIPELINE_ERROR_READ: FFmpegDemuxer: demuxer seek failed`, observed on a
// file ffmpeg decodes end to end without a defect), and on main any media error
// emptied the editor.

afterEach(cleanup);

const SOURCES: VideoSource[] = [{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" }];
const CLIPS: AxcutClip[] = [
	{
		id: "clip_1",
		assetId: "a1",
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "user",
		reason: "",
	},
];

/** A `<video>` that behaves like a real one on the only axis this file tests:
 *  a `currentTime` write starts a seek, and the element stays `seeking` until
 *  the browser says otherwise. */
function driveVideo(element: HTMLVideoElement) {
	let currentTime = 0;
	let seeking = false;
	const writes: number[] = [];
	Object.defineProperty(element, "currentTime", {
		configurable: true,
		get: () => currentTime,
		set: (next: number) => {
			currentTime = next;
			seeking = true;
			writes.push(next);
		},
	});
	Object.defineProperty(element, "seeking", { configurable: true, get: () => seeking });
	Object.defineProperty(element, "paused", { configurable: true, get: () => true });
	Object.defineProperty(element, "readyState", { configurable: true, get: () => 4 });
	Object.defineProperty(element, "duration", { configurable: true, get: () => 10 });
	element.play = vi.fn(() => Promise.resolve());
	element.pause = vi.fn();
	return {
		writes,
		get currentTime() {
			return currentTime;
		},
		/** What the browser does when the demuxer is done. */
		finishSeek: () => {
			seeking = false;
			act(() => {
				fireEvent.seeked(element);
			});
		},
	};
}

function mount() {
	let requestId = 0;
	const tree = (seekTarget: { timeSec: number; requestId: number } | null) => (
		<VirtualPreview videoSources={SOURCES} clips={CLIPS} seekTarget={seekTarget} />
	);
	const view = render(tree(null));
	const element = view.container.querySelector("video");
	if (!element) throw new Error("no <video> rendered");
	const video = driveVideo(element as HTMLVideoElement);
	act(() => {
		fireEvent.loadedMetadata(element);
	});
	video.writes.length = 0;
	return {
		video,
		/** One rAF-throttled scrub publish, the way the shell emits them. */
		scrubTo: (timeSec: number) =>
			act(() => {
				requestId += 1;
				view.rerender(tree({ timeSec, requestId }));
			}),
	};
}

describe("VirtualPreview keeps one demuxer seek in flight (issue #395 root cause)", () => {
	it("does not stack a seek onto an element that is still seeking", () => {
		const { video, scrubTo } = mount();

		scrubTo(2);
		expect(video.writes).toEqual([2]); // demuxer busy from here

		scrubTo(4);
		scrubTo(6);
		scrubTo(8);

		// Three more scrub publishes, no extra seeks: this is the storm that made
		// the demuxer fail.
		expect(video.writes).toEqual([2]);
	});

	it("applies the newest target once the demuxer is free, not the queued ones", () => {
		const { video, scrubTo } = mount();

		scrubTo(2);
		scrubTo(4);
		scrubTo(6);
		scrubTo(8);

		video.finishSeek();

		// The last position the user asked for — the intermediate ones were never
		// destinations, and replaying them would be the storm again, delayed.
		expect(video.writes).toEqual([2, 8]);
		expect(video.currentTime).toBe(8);
	});

	it("stops seeking once the playhead settles", () => {
		const { video, scrubTo } = mount();

		scrubTo(5);
		video.finishSeek();
		expect(video.writes).toEqual([5]);

		// The drag ended on the position already reached: nothing more to do.
		scrubTo(5);
		video.finishSeek();
		expect(video.writes).toEqual([5]);
	});

	it("still serves an ordinary seek immediately when nothing is in flight", () => {
		const { video, scrubTo } = mount();

		scrubTo(3);
		video.finishSeek();
		scrubTo(7);

		expect(video.writes).toEqual([3, 7]);
	});
});

// What the rAF loop does to a playing audio element between two ticks. The measured story
// behind these is on `AUDIO_NUDGE_START_SEC`; the loop itself is driven end to end in
// VirtualPreview.playback.test.tsx ("primary audio keeps to the picture"), because a
// decision that is right in isolation says nothing about what the call site feeds it.
describe("steerAudio: a playing element is nudged, not seeked", () => {
	const playing = (driftSec: number, nudged = false) =>
		steerAudio(driftSec, true, false, false, nudged);

	it("leaves an element on the picture alone", () => {
		expect(playing(0.01)).toEqual({ seek: false, rateFactor: 1 });
		expect(playing(-0.01)).toEqual({ seek: false, rateFactor: 1 });
	});

	it("nudges the rate toward the picture instead of seeking, whichever side it is on", () => {
		// The drift the storm was measured at: what used to be re-seeked six times a second.
		const behind = playing(-0.1);
		const ahead = playing(0.1);
		expect(behind.seek).toBe(false);
		expect(ahead.seek).toBe(false);
		expect(behind.rateFactor).toBeGreaterThan(1);
		expect(ahead.rateFactor).toBeLessThan(1);
		// Symmetric: a lead is noticed sooner than a lag, so it must not be the slower to close.
		expect(behind.rateFactor - 1).toBeCloseTo(1 - ahead.rateFactor, 10);
	});

	it("stops nudging closer to the picture than it starts, so an edge does not flap", () => {
		const between = (AUDIO_NUDGE_START_SEC + AUDIO_NUDGE_STOP_SEC) / 2;
		expect(playing(between, false).rateFactor).toBe(1);
		expect(playing(between, true).rateFactor).not.toBe(1);
		expect(playing(AUDIO_NUDGE_STOP_SEC / 2, true).rateFactor).toBe(1);
	});

	it("seeks only past what a nudge can close", () => {
		expect(playing(AUDIO_SEEK_LEASH_SEC * 0.9).seek).toBe(false);
		expect(playing(AUDIO_SEEK_LEASH_SEC * 1.1)).toEqual({ seek: true, rateFactor: 1 });
		expect(playing(-AUDIO_SEEK_LEASH_SEC * 1.1).seek).toBe(true);
	});

	it("places a parked element exactly", () => {
		expect(steerAudio(0.05, false, false, false, false).seek).toBe(true);
		expect(steerAudio(0.01, false, false, false, false).seek).toBe(false);
	});

	it("follows an explicit jump of the picture whatever the drift", () => {
		expect(steerAudio(0.001, true, false, true, false).seek).toBe(true);
		expect(steerAudio(0.08, false, false, true, false).seek).toBe(true);
	});

	// The discipline the video path learned in issue #395: a write onto an element that is
	// already seeking restarts the seek instead of finishing it, so the element never arrives.
	it("never stacks a write onto an element that is already seeking", () => {
		expect(steerAudio(5, true, true, false, false).seek).toBe(false);
		expect(steerAudio(5, false, true, false, false).seek).toBe(false);
		expect(steerAudio(0.001, true, true, true, false).seek).toBe(false); // the jump waits
	});
});

describe("shouldResyncAudio: an imported track free-runs inside a wide leash", () => {
	it("leaves a playing track alone inside the leash and corrects a real desync", () => {
		expect(shouldResyncAudio(0.2, true, IMPORTED_AUDIO_PLAYING_LEASH_SEC)).toBe(false);
		expect(shouldResyncAudio(-0.2, true, IMPORTED_AUDIO_PLAYING_LEASH_SEC)).toBe(false);
		expect(shouldResyncAudio(0.4, true, IMPORTED_AUDIO_PLAYING_LEASH_SEC)).toBe(true);
	});

	it("places a parked track exactly, and never onto one that is seeking", () => {
		expect(shouldResyncAudio(0.05, false, IMPORTED_AUDIO_PLAYING_LEASH_SEC)).toBe(true);
		expect(shouldResyncAudio(5, true, IMPORTED_AUDIO_PLAYING_LEASH_SEC, true)).toBe(false);
	});
});
