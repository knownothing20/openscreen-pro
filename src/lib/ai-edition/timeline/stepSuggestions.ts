import type { CursorTelemetryPoint } from "@/components/video-editor/types";

/**
 * Turning recorded clicks into tutorial steps.
 *
 * The only evidence available is where the cursor was and when it clicked. That is enough to
 * say "these clicks belong together, this one starts something new" — and it is NOT enough to
 * say what the user was doing. So a suggestion carries a time and nothing else; the label is
 * minted by the caller in the user's language ("Step 1"), never guessed from a coordinate.
 *
 * The two signals that split a group are the ones a person actually uses when describing a
 * screen recording: a pause long enough to read something, and a jump to a different part of
 * the screen.
 */

export interface StepSuggestion {
	/** Source time (ms) of the first click in the group — where the step begins. */
	startMs: number;
	/** Clicks that fell into this group. More than one is a repeated action, not a new step. */
	clicks: number;
}

export interface SuggestStepsOptions {
	/** A gap at least this long starts a new step. Below it, clicks accumulate. */
	gapMs?: number;
	/** A move of at least this fraction of the frame (0–1) starts a new step. */
	regionFraction?: number;
	/** Hard cap. A 60 s tutorial should not produce forty steps. */
	maxSteps?: number;
	/** Frame size, for turning the fraction into pixels. */
	frameWidth?: number;
	frameHeight?: number;
}

export const STEP_DEFAULTS = {
	gapMs: 2500,
	regionFraction: 0.28,
	maxSteps: 8,
} as const;

/**
 * Clicks only: a move sample is not evidence of intent, and including it would put a step
 * boundary on every cursor sweep.
 */
function clicksOf(points: readonly CursorTelemetryPoint[]): CursorTelemetryPoint[] {
	return points
		.filter((p) => p.interactionType?.includes("click") && Number.isFinite(p.timeMs))
		.sort((a, b) => a.timeMs - b.timeMs);
}

export function suggestSteps(
	points: readonly CursorTelemetryPoint[],
	options: SuggestStepsOptions = {},
): StepSuggestion[] {
	const gapMs = options.gapMs ?? STEP_DEFAULTS.gapMs;
	const regionFraction = options.regionFraction ?? STEP_DEFAULTS.regionFraction;
	const maxSteps = options.maxSteps ?? STEP_DEFAULTS.maxSteps;
	const frameWidth = options.frameWidth ?? 1920;
	const frameHeight = options.frameHeight ?? 1080;
	const regionPx = Math.hypot(frameWidth * regionFraction, frameHeight * regionFraction);

	const clicks = clicksOf(points);
	if (clicks.length === 0) return [];

	const groups: StepSuggestion[] = [];
	let current = { startMs: clicks[0].timeMs, clicks: 1, cx: clicks[0].cx, cy: clicks[0].cy };

	for (const click of clicks.slice(1)) {
		const waited = click.timeMs - current.startMs;
		const moved = Math.hypot(click.cx - current.cx, click.cy - current.cy);
		// Both tests are against the group's first click, not the previous one: a slow drift
		// across the screen should not read as "same place" just because each hop was small.
		if (waited >= gapMs || moved >= regionPx) {
			groups.push({ startMs: current.startMs, clicks: current.clicks });
			current = { startMs: click.timeMs, clicks: 1, cx: click.cx, cy: click.cy };
		} else {
			current.clicks += 1;
		}
	}
	groups.push({ startMs: current.startMs, clicks: current.clicks });

	// Keep the first `maxSteps` in time order rather than sampling: a tutorial is watched from
	// the start, so the early steps are the ones a viewer needs.
	return groups.slice(0, maxSteps);
}
