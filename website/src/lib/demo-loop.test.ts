import assert from "node:assert/strict";
import { test } from "node:test";

import { LOOP_BASE, loopPoster, loopSources, pickHeight } from "./demo-loop.ts";

test("a phone column gets the 720p file, even on a 3x screen", () => {
	assert.equal(pickHeight(343, 3), 720);
	assert.equal(pickHeight(390, 2), 720);
});

test("a docs column on a 2x laptop gets the 1080p file", () => {
	assert.equal(pickHeight(760, 2), 1080);
});

test("the same column on a 1x display stays on 720p", () => {
	assert.equal(pickHeight(760, 1), 720);
});

test("a missing or odd device pixel ratio is read as 1", () => {
	assert.equal(pickHeight(1200, 0), 720);
	assert.equal(pickHeight(1400, Number.NaN), 1080);
});

test("HEVC comes first, H.264 second, with the size in both names", () => {
	const [hevc, h264] = loopSources("classic-zoom", 720);
	assert.equal(hevc.src, `${LOOP_BASE}/classic-zoom-720-hevc.mp4`);
	assert.match(hevc.type, /hvc1\.1\.6\.L120/);
	assert.equal(h264.src, `${LOOP_BASE}/classic-zoom-720-h264.mp4`);
	assert.match(h264.type, /avc1\.64002a/);
	assert.match(loopSources("classic-zoom", 1080)[0].type, /L123/);
});

test("the poster sits beside the clips", () => {
	assert.equal(loopPoster("every-format"), `${LOOP_BASE}/every-format-poster.webp`);
});
