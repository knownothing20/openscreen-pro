import { isCameraMotionEasing } from "../cameraMotion/easingNames";
import { readClipAnchor } from "../cameraMotion/parse";
import {
	clampFocusEffectAngle,
	clampFocusEffectDimming,
	clampFocusEffectSize,
	clampFocusEffectSoftness,
	clampScreenMotionPerspective,
	clampScreenMotionPosition,
	clampScreenMotionRotation,
	clampScreenMotionScale,
	clampScreenMotionTimingSec,
	DEFAULT_SCREEN_MOTION_TIMING,
	FOCUS_EFFECT_DEFAULT,
	finiteOr,
	SCREEN_MOTION_DEFAULT_TARGET,
} from "./presets";
import type {
	FocusEffect,
	FocusEffectShape,
	FocusEffectTarget,
	ScreenMotionRegion,
	ScreenMotionTarget,
} from "./resolve";

/**
 * Reading a screen move out of a document.
 *
 * Hand-written rather than expressed as one zod object, for the same reason the camera's
 * is: the requirement is REPAIR, not rejection. A project whose region has `scale: "big"`
 * because someone edited the file must still open, with that one field put back in range,
 * and only a region that cannot be a region at all (no id, not an object) is dropped.
 *
 * This module is reachable from the MAIN process — schema → parse — so it imports only leaf
 * modules. `easingNames` carries the easing NAME set and nothing else; the curve maths in
 * `cameraMotion/easing` is renderer-only and must not be pulled in here, or the electron
 * build fails to resolve it (see the handover's third pitfall).
 */

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function parseScreenMotionTarget(value: unknown): ScreenMotionTarget {
	const raw = asRecord(value) ?? {};
	const fallback = SCREEN_MOTION_DEFAULT_TARGET;
	const position = asRecord(raw.position) ?? {};
	return {
		position: {
			x: clampScreenMotionPosition(position.x, fallback.position.x),
			y: clampScreenMotionPosition(position.y, fallback.position.y),
		},
		scale: clampScreenMotionScale(raw.scale, fallback.scale),
		rotationX: clampScreenMotionRotation(raw.rotationX, fallback.rotationX),
		rotationY: clampScreenMotionRotation(raw.rotationY, fallback.rotationY),
		rotationZ: clampScreenMotionRotation(raw.rotationZ, fallback.rotationZ),
		perspective: clampScreenMotionPerspective(raw.perspective, fallback.perspective),
	};
}

/**
 * The spotlight a screen move carries, or `undefined` when it carries none.
 *
 * `undefined` is the ANSWER for anything that is not a usable effect — an absent field, a
 * string, an array, an empty object — not a reason to substitute a default. The field is
 * optional precisely so that "no focus" has a representation, and handing back a populated
 * effect for a missing one would turn every project ever written into a dimmed one.
 *
 * The values inside it are repaired rather than rejected, like every other number in this
 * module: a hand-edited `size: 99` becomes 1, and the project still opens.
 */
export function parseFocusEffect(value: unknown): FocusEffect | undefined {
	const raw = asRecord(value);
	if (!raw) return undefined;

	const fallback = FOCUS_EFFECT_DEFAULT;
	// Unknown shapes and targets fall back rather than dropping the whole effect: a project
	// written by a newer build that grew a third shape must still dim on this one, not lose
	// the field silently.
	const shape: FocusEffectShape = raw.shape === "linear" ? "linear" : fallback.shape;
	const target: FocusEffectTarget = raw.target === "fixed" ? "fixed" : fallback.target;
	const center = asRecord(raw.center) ?? {};

	return {
		shape,
		angleDegrees: clampFocusEffectAngle(raw.angleDegrees, fallback.angleDegrees),
		target,
		center: {
			x: clampScreenMotionPosition(center.x, fallback.center.x),
			y: clampScreenMotionPosition(center.y, fallback.center.y),
		},
		size: clampFocusEffectSize(raw.size, fallback.size),
		softness: clampFocusEffectSoftness(raw.softness, fallback.softness),
		dimming: clampFocusEffectDimming(raw.dimming, fallback.dimming),
	};
}

/**
 * A stored region, or null when there is not enough there to be one.
 *
 * The span is repaired rather than rejected: `endMs <= startMs` becomes a one-millisecond
 * region, which is invisible but harmless, instead of taking the project down with it.
 */
export function parseScreenMotionRegion(value: unknown): ScreenMotionRegion | null {
	const raw = asRecord(value);
	if (!raw) return null;
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!id) return null;

	const startMs = finiteOr(raw.startMs, Number.NaN);
	const endMs = finiteOr(raw.endMs, Number.NaN);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

	const timing = asRecord(raw.timing) ?? {};
	const focusEffect = parseFocusEffect(raw.focusEffect);

	return {
		id,
		startMs,
		endMs: endMs > startMs ? endMs : startMs + 1,
		timing: {
			leadInSec: clampScreenMotionTimingSec(
				timing.leadInSec,
				DEFAULT_SCREEN_MOTION_TIMING.leadInSec,
			),
			returnSec: clampScreenMotionTimingSec(
				timing.returnSec,
				DEFAULT_SCREEN_MOTION_TIMING.returnSec,
			),
			// The easing NAME set is shared with the camera: one table, so a curve cannot
			// exist for one feature and not the other.
			easing: isCameraMotionEasing(timing.easing)
				? timing.easing
				: DEFAULT_SCREEN_MOTION_TIMING.easing,
		},
		target: parseScreenMotionTarget(raw.target),
		// Omitted, not `undefined`: a stored region without a focus effect must round-trip to
		// bytes that do not carry the key at all, so an older build reading the file back sees
		// exactly what it wrote.
		...(focusEffect ? { focusEffect } : {}),
		// Carried through, not dropped: the anchor is the source of truth for which clip the
		// move belongs to, so losing it here would make a save→reopen forget the region's
		// media, and a later clip reorder would leave the move pointing at whatever now sits
		// under its derived `startMs`. `readClipAnchor` is shared with the camera's parser so
		// the two kinds cannot drift on what counts as a usable anchor.
		...readClipAnchor(raw),
	};
}

export function parseScreenMotionRegions(value: unknown): ScreenMotionRegion[] {
	if (!Array.isArray(value)) return [];
	const regions: ScreenMotionRegion[] = [];
	for (const item of value) {
		const region = parseScreenMotionRegion(item);
		if (region) regions.push(region);
	}
	return regions;
}
