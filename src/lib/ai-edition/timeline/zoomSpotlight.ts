// The spotlight an applied zoom carries, and the one setting that decides its starting numbers.
//
// There is exactly ONE of those: `ZOOM_SPOTLIGHT_DEFAULT`. The Smart Zoom suggestions (the
// right pane's switch) and the Zoom Inspector's own switch both read it, so a spotlight
// applied from a suggestion and one switched on afterwards look the same on the first frame —
// 0.35 dimming was measured on real footage (0.75 left the centre at 73 % brightness and the
// whole picture grey), and a second default would mean two answers to one question.
//
// The effect itself is stored on the zoom region (`focusEffect`), optional and nullable:
// absent/null is "no spotlight", and the compositor draws nothing (the key is not even sent).

import type { FocusEffectShape } from "@/lib/ai-edition/screenMotion/resolve";

/** The four numbers a zoom's spotlight is authored with. No centre: the compositor derives it
 *  from the zoom's own focus point, which is the only value that cannot drift from the picture. */
export interface ZoomSpotlight {
	shape: FocusEffectShape;
	size: number;
	softness: number;
	dimming: number;
}

export const ZOOM_SPOTLIGHT_DEFAULT: ZoomSpotlight = {
	shape: "radial",
	size: 0.3,
	softness: 0.25,
	dimming: 0.35,
};

/** What the Inspector can produce. A value it can write is a value the document accepts, and
 *  the schema's own bounds (0..1) are wider than anything a slider should reach. */
export const ZOOM_SPOTLIGHT_LIMITS = {
	sizeMin: 0.1,
	sizeMax: 0.6,
	softnessMin: 0,
	softnessMax: 0.8,
	dimmingMin: 0.05,
	dimmingMax: 0.8,
} as const;

export function zoomSpotlightDefaults(): ZoomSpotlight {
	return { ...ZOOM_SPOTLIGHT_DEFAULT };
}

/**
 * What the pane shows for a region: the stored effect, with the shared default filling any
 * field it left out (the schema allows every field to be absent, so a hand-written
 * `{ "dimming": 0.5 }` is legal and must read as "a 0.5 pool at the default size").
 */
export function zoomSpotlightOf(effect: Partial<ZoomSpotlight> | null | undefined): ZoomSpotlight {
	return {
		shape: effect?.shape ?? ZOOM_SPOTLIGHT_DEFAULT.shape,
		size: effect?.size ?? ZOOM_SPOTLIGHT_DEFAULT.size,
		softness: effect?.softness ?? ZOOM_SPOTLIGHT_DEFAULT.softness,
		dimming: effect?.dimming ?? ZOOM_SPOTLIGHT_DEFAULT.dimming,
	};
}

/** A stored effect the renderer would actually draw. */
export function hasZoomSpotlight(effect: Partial<ZoomSpotlight> | null | undefined): boolean {
	return !!effect && (effect.dimming ?? ZOOM_SPOTLIGHT_DEFAULT.dimming) > 0;
}
