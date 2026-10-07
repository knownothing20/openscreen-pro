/**
 * The two panels still drawn: the recorder and the export. Captions and the
 * agent are filmed now (content.ts names their loops).
 *
 * Every string in here is a string the application shows, and every one of them
 * is either in the fixture the editor above is driven from or in the repository
 * — the quality tiers are the export dialog's, the capture chips are what macOS
 * reports for the take.
 * The panels are illustrations and are labelled as such by their `role="img"`,
 * which is also why the placeholder bars and window controls are drawn rather
 * than described: with the subtree collapsed to one label, nothing in here is
 * read out twice.
 *
 * Sizes are the design's. The only thing that moved is where the two wallpapers
 * come from: both are already on the page, loaded by the composite the editor
 * scrubs, so the panels reuse those two URLs and cost no further request.
 */

import { CircleCheck, Mic, Volume1 } from "lucide-react";
import type { ReactNode } from "react";

import styles from "./styles.module.css";

/** macOS window controls, drawn once for every panel that has a title bar. */
function TrafficLights({ small }: { small?: boolean }) {
	const cls = small ? styles.dotSm : styles.dot;
	return (
		<>
			<span className={`${cls} ${styles.dotRed}`} />
			<span className={`${cls} ${styles.dotAmber}`} />
			<span className={`${cls} ${styles.dotGreen}`} />
		</>
	);
}

function Bar({ name }: { name: string }) {
	return (
		<div className={styles.panelBar}>
			<TrafficLights />
			<span className={styles.panelName}>{name}</span>
			<span className={styles.panelPad} />
		</div>
	);
}

function RecordPanel() {
	return (
		<div className={styles.panel}>
			<Bar name="New recording" />
			<div className={styles.recBody}>
				<div className={styles.targets}>
					<div className={`${styles.target} ${styles.targetOn}`}>
						<img
							className={styles.targetShot}
							src="/img/walkthrough/canvas-bg-1.jpg"
							alt=""
							width={1200}
							height={675}
							loading="lazy"
							decoding="async"
						/>
						<div className={`${styles.targetFoot} ${styles.targetFootOn}`}>
							<span className={styles.targetNameOn}>Display 1</span>
							<CircleCheck className={styles.targetTick} size={15} strokeWidth={2.2} />
						</div>
					</div>

					<div className={`${styles.target} ${styles.targetOff}`}>
						<div className={styles.miniWin}>
							<div className={styles.miniBar}>
								<span className={styles.miniDot} />
								<span className={styles.miniDot} />
							</div>
							<div className={styles.miniBody}>
								<span className={`${styles.miniLine} ${styles.phA}`} style={{ width: "64%" }} />
								<span className={`${styles.miniLine} ${styles.phB}`} style={{ width: "82%" }} />
							</div>
						</div>
						<div className={styles.targetFoot}>
							<span className={styles.targetNameOff}>Window — Terminal</span>
						</div>
					</div>
				</div>

				<div className={styles.chips}>
					<span className={styles.chip}>ScreenCaptureKit</span>
					<span className={styles.chip}>system audio</span>
					<span className={styles.chip}>1920 × 1080 · 60 fps</span>
				</div>

				<div className={styles.recFoot}>
					<div className={styles.toggles}>
						<span className={styles.toggle}>
							<Mic size={14} />
						</span>
						<span className={`${styles.toggle} ${styles.toggleOff}`}>
							<Volume1 size={14} />
						</span>
					</div>
					<span className={styles.recStart}>
						<span className={styles.recDot} />
						Start recording
					</span>
				</div>
			</div>
		</div>
	);
}

function ExportPanel() {
	return (
		<div className={styles.panel}>
			<Bar name="Export" />
			<div className={styles.expBody}>
				<div className={styles.expHead}>
					<span className={styles.expFile}>recording-1783066227227.mp4</span>
					<span className={styles.expContainer}>MP4</span>
				</div>

				{/* One settings panel: quality and frame rate rows, and no codec row to pick. */}
				<div className={styles.pills}>
					<span className={styles.pill}>720p</span>
					<span className={`${styles.pill} ${styles.pillOn}`}>1080p</span>
					<span className={styles.pill}>Source</span>
				</div>
				<div className={styles.pills}>
					<span className={styles.pill}>24</span>
					<span className={styles.pill}>30</span>
					<span className={`${styles.pill} ${styles.pillOn}`}>60</span>
				</div>

				<div>
					<div className={styles.track}>
						<span className={styles.fill} />
					</div>
					<div className={styles.trackFoot}>
						<span className={styles.frames}>frame 1 488 / 2 400</span>
						<span className={styles.pct}>62%</span>
					</div>
				</div>

				<div className={styles.expNote}>
					writing to ~/Movies — no queue, no account, no watermark
				</div>
			</div>
		</div>
	);
}

/** Keyed by the feature id in `content.ts`. */
export const PANELS: Record<string, ReactNode> = {
	record: <RecordPanel />,
	export: <ExportPanel />,
};
