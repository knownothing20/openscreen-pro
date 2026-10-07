/**
 * Everything the page says after the editor has finished demonstrating itself.
 *
 * The scroll-driven editor above this section is where the product is argued:
 * six settings, shown working, on a real project file. That leaves this section
 * a narrower job — the parts of the app the editor is not — and there are four
 * of them: the recorder in front of it, the encoder behind it, and the two
 * features that are easier to show than to describe.
 *
 * All four now get a picture, which reverses the split this file used to carry.
 * The old argument was that a screenshot of a format dropdown proves nothing a
 * sentence does not and costs a request to say it. That argument was about
 * screenshots. These four panels are drawn in DOM: they cost no photograph and
 * no second request, they re-render in the page's own typeface and swap with
 * the theme, and they cannot go stale against a repaint of the application the
 * way a plate shot on one build does. The reason to withhold a picture was its
 * price; the price is gone.
 *
 * What has not changed is that the copy has to stand on its own. Every panel
 * here is a drawing, it is labelled as one, and nothing in this section asks to
 * be believed on the strength of it. The specification line under each claim is
 * still doing the work.
 *
 * Two of the four are no longer drawn. Captions and the agent are filmed:
 * loops exported from the app itself, lazy and served from R2 (see DemoLoop),
 * which the films section above this one already pays the set-up cost for. A
 * film shows what a drawing could only quote — the captions changing language,
 * the agent's edits landing on the timeline. The recorder and the encoder have
 * no film yet and keep their drawings.
 */

import { translate } from "@docusaurus/Translate";

import type { LoopName } from "../../lib/demo-loop";

export type Feature = {
	id: string;
	kicker: string;
	claim: string;
	body: string;
	fact: string;
	/** The docs page that backs the claim, first. A drawing asks nobody to
	 *  believe it; the reference is where the specification line can be
	 *  checked. A feature page, where one exists, follows it. */
	links: { to: string; label: string }[];
	/** What the drawn panel depicts, for anyone who cannot see it. Only on a
	 *  drawn band: a filmed one carries its loop's own label. */
	label?: string;
	/** A loop of the app in place of the drawing. */
	video?: LoopName;
	/** Layout only — the copy stays first in the DOM either way. */
	flip?: boolean;
};

// For translators, on every drawing's label: the panels are drawn in English,
// so the text the label quotes from them stays as drawn.
const DRAWING =
	"Describes a drawing of the app for screen readers. The drawing is in English: keep the quoted words as drawn.";

/**
 * The four bands, built at render: translate() answers in the locale being
 * rendered, so the copy cannot be a module-level constant.
 */
export function getFeatures(): Feature[] {
	return [
		{
			id: "record",
			kicker: translate({ id: "showcase.record.kicker", message: "record" }),
			claim: translate({
				id: "showcase.record.claim",
				message: "It records with the operating system, not around it.",
			}),
			body: translate({
				id: "showcase.record.body",
				message:
					"Pick a window or a display. macOS goes through ScreenCaptureKit, Windows through Windows Graphics Capture, Linux through PipeWire and the ScreenCast portal — on each, the capture path the system itself provides. The pointer is recorded as data rather than burned into the pixels, which is the only reason you could restyle it further up this page.",
			}),
			fact: translate({
				id: "showcase.record.fact",
				message:
					"ScreenCaptureKit · Windows Graphics Capture · PipeWire · system audio without an extra driver",
			}),
			links: [
				{
					to: "/docs/recording/",
					label: translate({ id: "showcase.record.link.docs", message: "Screen recording docs" }),
				},
			],
			label: translate({
				id: "showcase.record.label",
				description: DRAWING,
				message:
					"A drawing of the recorder: two capture targets side by side, Display 1 selected and a window titled Terminal beside it, then the settings for the take — ScreenCaptureKit, system audio, 1920 × 1080 at 60 fps — a microphone and a system-audio toggle, and a Start recording button.",
			}),
		},
		{
			id: "export",
			kicker: translate({ id: "showcase.export.kicker", message: "export" }),
			claim: translate({ id: "showcase.export.claim", message: "Then it writes the file." }),
			body: translate({
				id: "showcase.export.body",
				message:
					"MP4 from 720p up to source, at 24, 30 or 60, in H.264 — or a GIF. The encode runs on your machine and counts frames while it does. No queue, no account, no watermark, and the file is on disk when the bar fills.",
			}),
			fact: translate({
				id: "showcase.export.fact",
				message: "H.264 · 24, 30, 60 fps · no watermark",
			}),
			links: [
				{
					to: "/docs/export/",
					label: translate({ id: "showcase.export.link.docs", message: "Video export docs" }),
				},
			],
			label: translate({
				id: "showcase.export.label",
				description: DRAWING,
				message:
					"A drawing of the export panel: recording-1783066227227.mp4 going out as MP4 at 1080p and 60 fps, with the quality and frame rate rows above a progress bar 62 percent along reading frame 1 488 of 2 400, writing to the Movies folder.",
			}),
			flip: true,
		},
		{
			id: "captions",
			kicker: translate({ id: "showcase.captions.kicker", message: "captions" }),
			claim: translate({
				id: "showcase.captions.claim",
				message: "Transcription runs on your machine.",
			}),
			body: translate({
				id: "showcase.captions.body",
				message:
					"whisper.cpp ships with the app, and the model downloads once on first use — after that it works with the network off. The audio never leaves the laptop, and what comes back is editable text: set the typeface, the size, the color and the position, then burn it into the render.",
			}),
			// 100: the whisper.cpp codes the "Regenerate as" picker offers
			// (TRANSCRIPT_LANGUAGE_CODES in src/lib/ai-edition/schema, less "auto").
			fact: translate({
				id: "showcase.captions.fact",
				message: "whisper.cpp · 100 languages · offline after first run",
			}),
			links: [
				{
					to: "/docs/captions/",
					label: translate({
						id: "showcase.captions.link.docs",
						message: "Captions and transcript docs",
					}),
				},
				{
					to: "/features/captions/",
					label: translate({
						id: "showcase.captions.link.feature",
						message: "How local captions compare",
						description: "Link label under the panel.",
					}),
				},
			],
			video: "automatic-subtitles",
		},
		{
			id: "agent",
			kicker: translate({ id: "showcase.agent.kicker", message: "agent" }),
			claim: translate({
				id: "showcase.agent.claim",
				message: "Describe the edit. The agent makes it.",
			}),
			body: translate({
				id: "showcase.agent.body",
				message:
					"The wizard further up this page places zooms by watching where your cursor went. The agent goes further: it reads the actual transcript and the actual timeline, so it answers with timecodes you can go and check — which spans it will cut, and how much that saves. Every edit it makes is an ordinary undoable one, and it needs a provider key you supply. Nothing runs until you connect one.",
			}),
			fact: translate({
				id: "showcase.agent.fact",
				message: "bring your own key · off by default · every edit is undoable",
			}),
			// The body opens on the zoom wizard, so its page is the second link.
			links: [
				{
					to: "/docs/ai-editing/",
					label: translate({ id: "showcase.agent.link.docs", message: "AI editing docs" }),
				},
				{
					to: "/features/auto-zoom/",
					label: translate({
						id: "showcase.agent.link.feature",
						message: "How automatic zooms work",
						description: "Link label under the panel.",
					}),
				},
			],
			video: "ask-the-agent",
			flip: true,
		},
	];
}
