/**
 * The films under the editor, and what each one says.
 *
 * The scroll-driven editor above already shows five things working: the
 * background, the frame effects, the cursor settings, the zoom wand and the
 * transcript. These blocks are for what it does not reach: the look a take
 * opens with, depth (the 3D camera, the cursor packs, device frames and
 * animated backgrounds), the webcam, and the last steps before a file leaves
 * (the format and the blur). Captions and the agent get theirs in the Showcase
 * bands below, beside the copy those bands already carry.
 *
 * Every claim here was checked against the app: the option names are the
 * English UI's own, the defaults are src/lib/projectDefaults.ts.
 */

import Translate, { translate } from "@docusaurus/Translate";
import type { ReactNode } from "react";

import type { LoopName } from "../../lib/demo-loop";

export type Tab = { label: string; loop: LoopName };

export type Block = {
	id: string;
	kicker: string;
	title: string;
	lead: ReactNode;
	/** One loop, or several taking turns behind a tab bar. */
	tabs: Tab[];
	notes: ReactNode[];
};

export type PairBlock = {
	id: string;
	kicker: string;
	title: string;
	lead: ReactNode;
	items: { loop: LoopName; caption: ReactNode }[];
};

const b = (s: ReactNode) => <strong>{s}</strong>;

export function getBlocks(): Block[] {
	return [
		{
			id: "default",
			kicker: translate({ id: "films.default.kicker", message: "Out of the box" }),
			title: translate({
				id: "films.default.title",
				message: "Good-looking from the first take.",
			}),
			lead: (
				<Translate
					id="films.default.lead"
					values={{
						zoomed: b(
							<Translate id="films.default.lead.zoomed">already zoomed on your clicks</Translate>,
						),
					}}
				>
					{
						"Every new recording opens {zoomed}, on a wallpaper, with padding, a shadow and rounded corners. Change any of it, or export it as it is."
					}
				</Translate>
			),
			tabs: [
				// One loop, so no tab bar and no label to show.
				{ label: "", loop: "beautiful-by-default" },
			],
			notes: [
				<Translate
					key="zooms"
					id="films.default.note.zooms"
					values={{
						t: b(<Translate id="films.default.note.zooms.t">Zooms from your clicks.</Translate>),
					}}
				>
					{
						"{t} Each take is zoomed where you clicked, by a fixed rule: no AI, no network call. Turn it off in Record mode."
					}
				</Translate>,
				<Translate
					key="frame"
					id="films.default.note.frame"
					values={{
						t: b(<Translate id="films.default.note.frame.t">A finished frame.</Translate>),
					}}
				>
					{
						"{t} Wallpaper, padding, shadow, rounded corners and a little motion blur are on before you touch anything."
					}
				</Translate>,
				<Translate
					key="cursor"
					id="films.default.note.cursor"
					values={{
						t: b(<Translate id="films.default.note.cursor.t">A cursor you can redo.</Translate>),
					}}
				>
					{
						"{t} The pointer is recorded apart from the pixels, so its size and style can change after the take."
					}
				</Translate>,
			],
		},
		{
			id: "depth",
			kicker: translate({ id: "films.depth.kicker", message: "3D" }),
			title: translate({ id: "films.depth.title", message: "Depth, not just zoom." }),
			lead: (
				<Translate
					id="films.depth.lead"
					values={{
						orbit: b(<Translate id="films.depth.lead.orbit">orbit the screen</Translate>),
						cursor: b(<Translate id="films.depth.lead.cursor">a 3D cursor</Translate>),
						device: b(<Translate id="films.depth.lead.device">in a device</Translate>),
					}}
				>
					{
						"Turn the screen or {orbit} as you zoom, draw the pointer as {cursor} with a shadow, and put the whole take {device}, over a background that moves."
					}
				</Translate>
			),
			tabs: [
				{
					label: translate({ id: "films.depth.tab.camera", message: "3D camera" }),
					loop: "3d-camera",
				},
				{
					label: translate({ id: "films.depth.tab.cursors", message: "Cursors" }),
					loop: "3d-cursors",
				},
				{
					label: translate({ id: "films.depth.tab.frames", message: "Device frames" }),
					loop: "device-frames",
				},
				{
					label: translate({ id: "films.depth.tab.backgrounds", message: "Animated backgrounds" }),
					loop: "animated-backgrounds",
				},
			],
			notes: [
				<Translate
					key="camera"
					id="films.depth.note.camera"
					values={{ t: b(<Translate id="films.depth.note.camera.t">3D camera.</Translate>) }}
				>
					{
						"{t} Each zoom can stay flat, turn the screen left or right, or orbit it while following the zoom's focus. Depth of field softens the far side."
					}
				</Translate>,
				<Translate
					key="cursors"
					id="films.depth.note.cursors"
					values={{
						t: b(<Translate id="films.depth.note.cursors.t">Five cursor packs.</Translate>),
					}}
				>
					{
						"{t} Studio Ink, Prism Glow, Pop Coral, Pixel Candy and Star Sprout, each of which can be drawn as a 3D object with a shadow."
					}
				</Translate>,
				<Translate
					key="frames"
					id="films.depth.note.frames"
					values={{
						t: b(<Translate id="films.depth.note.frames.t">Frames and motion.</Translate>),
					}}
				>
					{
						"{t} A window, laptop, phone or screen, light or dark, over a background animated with Drift, Aurora or Waves."
					}
				</Translate>,
			],
		},
		{
			id: "camera",
			kicker: translate({ id: "films.camera.kicker", message: "Camera" }),
			title: translate({
				id: "films.camera.title",
				message: "Your camera, your screen, or both.",
			}),
			lead: (
				<Translate
					id="films.camera.lead"
					values={{
						layouts: b(
							<Translate id="films.camera.lead.layouts">
								picture in picture, side by side, stacked or full screen
							</Translate>,
						),
						blurred: b(<Translate id="films.camera.lead.blurred">blurred</Translate>),
					}}
				>
					{
						"One take with a webcam can be {layouts}, and the room behind you can be {blurred}, cut out or replaced on your own computer, with no green screen."
					}
				</Translate>
			),
			tabs: [
				{
					label: translate({ id: "films.camera.tab.layouts", message: "Layouts" }),
					loop: "every-layout",
				},
				{
					label: translate({ id: "films.camera.tab.blur", message: "Background blur" }),
					loop: "camera-blur",
				},
			],
			notes: [
				<Translate
					key="layouts"
					id="films.camera.note.layouts"
					values={{ t: b(<Translate id="films.camera.note.layouts.t">Four layouts.</Translate>) }}
				>
					{"{t} Picture in picture, dual frame, vertical stack, or no webcam at all."}
				</Translate>,
				<Translate
					key="full"
					id="films.camera.note.full"
					values={{ t: b(<Translate id="films.camera.note.full.t">Full Camera.</Translate>) }}
				>
					{
						"{t} Give a stretch of the timeline to the camera: it grows to full screen, then eases back."
					}
				</Translate>,
				<Translate
					key="background"
					id="films.camera.note.background"
					values={{
						t: b(
							<Translate id="films.camera.note.background.t">Blur, cut out or replace.</Translate>,
						),
					}}
				>
					{
						"{t} A segmentation model separates you from the room on your own computer. Nothing is uploaded."
					}
				</Translate>,
			],
		},
	];
}

export function getPair(): PairBlock {
	return {
		id: "ship",
		kicker: translate({ id: "films.ship.kicker", message: "Before it ships" }),
		title: translate({
			id: "films.ship.title",
			message: "Fit any format. Blur what should not be seen.",
		}),
		lead: (
			<Translate
				id="films.ship.lead"
				values={{
					formats: b(<Translate id="films.ship.lead.formats">wide, square or vertical</Translate>),
					blur: b(<Translate id="films.ship.lead.blur">under a blur</Translate>),
				}}
			>
				{"One take becomes {formats}, and whatever should not be seen stays {blur}."}
			</Translate>
		),
		items: [
			{
				loop: "every-format",
				caption: (
					<Translate
						id="films.ship.formats"
						values={{ t: b(<Translate id="films.ship.formats.t">Any aspect ratio.</Translate>) }}
					>
						{"{t} The same take, framed for 16:9, 9:16, 1:1, 4:3, 4:5, 16:10 or 10:16."}
					</Translate>
				),
			},
			{
				loop: "sensitive-data-mask",
				caption: (
					<Translate
						id="films.ship.blur"
						values={{ t: b(<Translate id="films.ship.blur.t">Blur regions.</Translate>) }}
					>
						{
							"{t} Smooth or mosaic, as a rectangle, an oval or a freehand shape, over an email, a key or a password."
						}
					</Translate>
				),
			},
		],
	};
}
