import { type FocusEffect, resolveScreenMotionWinner, type ScreenMotionRegion } from "./resolve";

/**
 * The spotlight at one instant, resolved once for both consumers.
 *
 * `center` is already a point, not a choice: the `animation` target means "over wherever
 * this move is going", and working that out is this module's job so a renderer never has to
 * know the target enum exists.
 */
export interface FocusEffectSample {
	effect: FocusEffect;
	center: { x: number; y: number };
	/** How far into its own move the owning region is, 0..1. */
	progress: number;
}

/**
 * How far into its own motion the owning region is — the SAME envelope the move itself uses.
 *
 * That identity is the point, not a coincidence. A spotlight that faded on its own clock
 * would drift against the card it is following, and the drift would only show up as "the
 * light lags the move" once both are on screen. One envelope for the region means the two
 * can never disagree; the call into `resolveScreenMotionWinner` is the app's existing way of
 * asking it, and re-implementing the eased lead-in here is exactly what would break that.
 *
 * Returns null when nothing is animating at `timeMs`, when the winner carries no effect, or
 * when the effect is authored to draw nothing. The last is not an error case: `dimming: 0`
 * is how a user turns the spotlight off, and it must cost the renderer no work at all.
 */
export function resolveFocusEffectAt(input: {
	regions: readonly ScreenMotionRegion[];
	timeMs: number;
	speedRegions?: Parameters<typeof resolveScreenMotionWinner>[0]["speedRegions"];
}): FocusEffectSample | null {
	const winner = resolveScreenMotionWinner({
		regions: input.regions,
		timeMs: input.timeMs,
		...(input.speedRegions ? { speedRegions: input.speedRegions } : {}),
	});
	if (!winner) return null;

	const region = input.regions.find((candidate) => candidate.id === winner.regionId);
	const effect = region?.focusEffect;
	if (!effect) return null;

	// Nothing to draw. Checked before the sample is built so a disabled spotlight is
	// `null` rather than a zero-progress effect a renderer would still have to branch on.
	if (effect.dimming <= 0) return null;

	return {
		effect,
		// An `animation` spotlight rides the move's own destination. It reads the AUTHORED
		// target, not the blended state: the target is where the card is going, which is
		// what the user aimed at, and a light that tracked the blend would slide through the
		// whole transition instead of sitting where the move lands.
		center:
			effect.target === "fixed"
				? { x: effect.center.x, y: effect.center.y }
				: winner.target.position,
		progress: winner.progress,
	};
}
