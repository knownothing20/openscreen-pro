import { cameraMotionEasingFn } from "../cameraMotion/easing";
import { cameraMotionProgressAt } from "../cameraMotion/resolve";
import { type SpeedRegion, screenTimeMs } from "../timeline/speed";

/**
 * The screen card as a renderer wants it, in the same normalized language the camera's
 * motion uses: `position` is 0..1 across the canvas (0 = flush left/top, 0.5 = centred,
 * 1 = flush right/bottom), `scale` is a MULTIPLIER on the card's own base placement
 * (1 = exactly as the project places it), and the rotations are degrees.
 *
 * `perspective` is authored and carried, but NOT APPLIED — no renderer reads it. The quad's
 * perspective is `min(width, height) × ROTATION_3D_PERSPECTIVE_FACTOR`, a constant the author
 * cannot yet steer. It rides along so the model and the wire stay complete for the slice that
 * gives it an effect; until then it is a knob with nothing behind it, and the Inspector must
 * not offer it. Same status as Camera Motion's `opacity`.
 *
 * Modelled on DogSC's `ScreenMotionState`. Unlike the camera there is no discrete shape to
 * resolve — a screen move authors continuous numbers directly — so a target IS a state.
 */
export interface ScreenMotionState {
	position: { x: number; y: number };
	scale: number;
	rotationX: number;
	rotationY: number;
	rotationZ: number;
	perspective: number;
}

/** What a region authors. Continuous, so a target and a sample are the same shape. */
export type ScreenMotionTarget = ScreenMotionState;

export interface ScreenMotionRegionTiming {
	leadInSec: number;
	returnSec: number;
	easing: Parameters<typeof cameraMotionEasingFn>[0];
}

/** What a focus effect draws: a round pool of light, or a directional band. */
export type FocusEffectShape = "radial" | "linear";

/** Where the pool of light sits: over the region's own move, or pinned by `center`. */
export type FocusEffectTarget = "animation" | "fixed";

/**
 * An optional spotlight carried by a screen move: everything outside a region of the frame
 * is dimmed, so the eye lands where the move is going.
 *
 * An ABSENT effect means no work, not a hidden default — the same reading DogSC gives its
 * own, and the reason the field is optional rather than defaulted on the region.
 *
 * Deliberately carries NO blur. DogSC's effect also softens what it leaves outside, but this
 * app already blurs for a different reason — the annotation `blurData`, which HIDES what it
 * covers. Two things that look alike and mean the opposite would be a control the user has
 * to read the docs to tell apart, so the focus effect owns dimming and leaves hiding to the
 * privacy tool. `dimming: 0` therefore reads as "this effect is off".
 *
 * All coordinates are normalised 0..1. `size` is a fraction of the frame's shorter side,
 * matching what DogSC measures against.
 */
export interface FocusEffect {
	shape: FocusEffectShape;
	/** The band's direction in degrees, 0..360. Read only by `linear`. */
	angleDegrees: number;
	target: FocusEffectTarget;
	/** The pool's centre, 0..1, read only by `fixed`. */
	center: { x: number; y: number };
	/** How wide the clear region is, as a fraction of the shorter side. */
	size: number;
	/** How far the dimming bleeds into the clear region, 0..1. */
	softness: number;
	/** How dark the outside gets, 0..1. Zero means the effect draws nothing. */
	dimming: number;
}

/**
 * A stored screen move.
 *
 * `startMs`/`endMs` are the same derived RAW-virtual span every other region carries, so a
 * screen move trims, reorders and ripples with its footage exactly like a zoom does.
 */
export interface ScreenMotionRegion {
	id: string;
	startMs: number;
	endMs: number;
	timing: ScreenMotionRegionTiming;
	target: ScreenMotionTarget;
	/**
	 * The optional spotlight, absent on every region written before this existed and on
	 * every region a user has not asked to focus. Defaulted rather than migrated: an older
	 * document simply reads as "no focus", so no `schemaVersion` bump is owed.
	 */
	focusEffect?: FocusEffect;
	/**
	 * The v5 clip anchor, the same triple a zoom and an annotation carry: it is the SOURCE
	 * OF TRUTH for where the move belongs, and `startMs`/`endMs` are a derived cache of it.
	 * Optional on the same terms as everywhere else — a document written before the anchor
	 * existed has no triple, and one is never invented for it.
	 */
	clipId?: string;
	sourceStartSec?: number;
	sourceEndSec?: number;
}

/**
 * The space the card lives in: the canvas, and the card's own size at scale 1.
 *
 * This is what makes the interpolation below correct. DogSC's note is the reason it exists:
 * interpolating `position` and `scale` INDEPENDENTLY walks the card along
 * `position × (canvas − scaledCard)`, which first grows it in the middle and only then
 * slides it — the anchor drifts through the whole transition. Interpolating the two ends of
 * that product instead keeps the anchor on the straight line between them.
 */
export interface ScreenMotionViewport {
	canvasWidth: number;
	canvasHeight: number;
	/** The base placement's size — the card at scale 1. */
	baseWidth: number;
	baseHeight: number;
}

/** A pixel rect in canvas space — what both renderers actually draw. */
export interface ScreenMotionRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ScreenMotionSample {
	/** The normalized state, for the Inspector and for parity with the native side. */
	state: ScreenMotionState;
	/** The card's rect at this instant, or null when no viewport was known. */
	rect: ScreenMotionRect | null;
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

/**
 * The card's pixel rect for a state — the FORWARD formula, never its inverse.
 *
 * DogSC converts a moving, scaled card back into a normalized position by dividing by
 * `canvas − scaledCard`, and records that the denominator crosses zero when the card grows
 * through canvas size, which cost them a one-frame jump. Nothing here ever divides: the
 * rect is built from `position` and `scale`, so there is no inverse to blow up.
 */
export function screenMotionRectAt(
	state: ScreenMotionState,
	viewport: ScreenMotionViewport,
): ScreenMotionRect {
	const width = state.scale * viewport.baseWidth;
	const height = state.scale * viewport.baseHeight;
	return {
		x: state.position.x * (viewport.canvasWidth - width),
		y: state.position.y * (viewport.canvasHeight - height),
		width,
		height,
	};
}

/**
 * The base state a project's ordinary screen placement corresponds to: where the card
 * already is, at scale 1.
 *
 * The inverse divide lives HERE and nowhere else, on a value that does not move: the base
 * rect is the layout's, computed once. The guard is the same one DogSC uses, so a card that
 * fills the canvas resolves to the centre rather than to infinity.
 */
export function screenMotionBaseState(
	baseRect: ScreenMotionRect,
	viewport: ScreenMotionViewport,
): ScreenMotionState {
	const denomX = viewport.canvasWidth - baseRect.width;
	const denomY = viewport.canvasHeight - baseRect.height;
	return {
		position: {
			x: Math.abs(denomX) > 0.001 ? clamp01(baseRect.x / denomX) : 0.5,
			y: Math.abs(denomY) > 0.001 ? clamp01(baseRect.y / denomY) : 0.5,
		},
		scale: 1,
		rotationX: 0,
		rotationY: 0,
		rotationZ: 0,
		perspective: 0,
	};
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/**
 * Blend two states, with position and scale travelling together through rect space.
 *
 * The intermediate `position` is deliberately NOT clamped to 0..1: a card growing past the
 * canvas needs a position outside the range for the product to stay on the straight line.
 * Only the PERSISTED target is required to be in range, which is `presets.ts`'s job.
 */
export function lerpScreenMotionState(
	from: ScreenMotionState,
	to: ScreenMotionState,
	t: number,
	viewport: ScreenMotionViewport | null,
): ScreenMotionState {
	let position: { x: number; y: number };
	if (viewport) {
		const scaledW0 = from.scale * viewport.baseWidth;
		const scaledW1 = to.scale * viewport.baseWidth;
		const scaledW = lerp(scaledW0, scaledW1, t);
		const ux = lerp(
			from.position.x * (viewport.canvasWidth - scaledW0),
			to.position.x * (viewport.canvasWidth - scaledW1),
			t,
		);
		const scaledH0 = from.scale * viewport.baseHeight;
		const scaledH1 = to.scale * viewport.baseHeight;
		const scaledH = lerp(scaledH0, scaledH1, t);
		const uy = lerp(
			from.position.y * (viewport.canvasHeight - scaledH0),
			to.position.y * (viewport.canvasHeight - scaledH1),
			t,
		);
		const denomX = viewport.canvasWidth - scaledW;
		const denomY = viewport.canvasHeight - scaledH;
		position = {
			x: Math.abs(denomX) > 0.001 ? ux / denomX : lerp(from.position.x, to.position.x, t),
			y: Math.abs(denomY) > 0.001 ? uy / denomY : lerp(from.position.y, to.position.y, t),
		};
	} else {
		position = {
			x: lerp(from.position.x, to.position.x, t),
			y: lerp(from.position.y, to.position.y, t),
		};
	}
	return {
		position,
		scale: lerp(from.scale, to.scale, t),
		rotationX: lerp(from.rotationX, to.rotationX, t),
		rotationY: lerp(from.rotationY, to.rotationY, t),
		rotationZ: lerp(from.rotationZ, to.rotationZ, t),
		perspective: lerp(from.perspective, to.perspective, t),
	};
}

/**
 * How far into its own motion a region is at `timeMs`.
 *
 * This IS the camera motion envelope, not a copy of it: 0 at the region's start, 1 through
 * its hold, 0 again at its end, lead-in and return clamped to half the length, times in
 * screen time so a speed change stretches the move with the footage. One envelope for both
 * features means a screen move and a camera move created with the same numbers arrive and
 * leave on the same rhythm, and there is no second curve to keep in step.
 *
 * Note the deliberate departure from DogSC: its screen motion returns AFTER `endTime`, so
 * the effect outlives its own pill. Here the return lives inside the region, which is what
 * the camera motion this app already ships does — the pill's edges are the effect's edges.
 */
export function screenMotionProgressAt(
	region: { startMs: number; endMs: number; timing: ScreenMotionRegionTiming },
	timeMs: number,
	speedRegions: readonly SpeedRegion[] = [],
): number {
	return cameraMotionProgressAt(region, timeMs, speedRegions);
}

/**
 * The region that owns `timeMs` and how far into its motion the instant is.
 *
 * Strongest wins, like every other overlapping region in this editor. The winner carries
 * the authored target rather than a blended sample, so a renderer eases the rect once
 * instead of twice.
 */
export function resolveScreenMotionWinner(input: {
	regions: readonly ScreenMotionRegion[];
	timeMs: number;
	speedRegions?: readonly SpeedRegion[];
}): { progress: number; target: ScreenMotionTarget; regionId: string } | null {
	const speedRegions = input.speedRegions ?? [];
	let bestProgress = 0;
	let bestTarget: ScreenMotionTarget | null = null;
	let bestId = "";

	for (const region of input.regions) {
		const progress = screenMotionProgressAt(region, input.timeMs, speedRegions);
		if (progress > bestProgress) {
			bestProgress = progress;
			bestTarget = region.target;
			bestId = region.id;
		}
	}

	if (!bestTarget || bestProgress <= 0) return null;
	return { progress: bestProgress, target: bestTarget, regionId: bestId };
}

/**
 * The screen at `timeMs`, resolved once for both consumers.
 *
 * Preview and export read the same winner: the scene description carries the authored
 * regions and the Rust compositor evaluates the same envelope from the same numbers, so
 * neither side can drift into "preview does one thing, export another".
 */
export function resolveScreenMotionAtTime(input: {
	baseRect: ScreenMotionRect;
	viewport: ScreenMotionViewport;
	regions: readonly ScreenMotionRegion[];
	timeMs: number;
	speedRegions?: readonly SpeedRegion[];
}): ScreenMotionSample {
	const base = screenMotionBaseState(input.baseRect, input.viewport);
	const winner = resolveScreenMotionWinner({
		regions: input.regions,
		timeMs: input.timeMs,
		speedRegions: input.speedRegions,
	});
	const state = winner
		? lerpScreenMotionState(base, winner.target, winner.progress, input.viewport)
		: base;
	return { state, rect: screenMotionRectAt(state, input.viewport) };
}

/** Screen time for a region boundary — exported so callers can line a region up with what
 *  the evaluator will use. */
export { screenTimeMs };
