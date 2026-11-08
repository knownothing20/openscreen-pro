import { Cpu, Loader2, MonitorCog, RefreshCw, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { resolveAspectRatioValue } from "@/lib/ai-edition/document/outputFormat";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import {
	buildDeviceOptions,
	type EncoderDeviceOption,
	encodersForCodec,
	resolveDeviceSelection,
	resolveEncoderDevice,
	softwareHevcSupportsSize,
	type VideoCodec,
} from "@/lib/encoderDevices";
import { resolveExportGeometry } from "@/lib/exporter/exportGeometry";
import { codecSupportNative, listGpusNative, selfTestEncoderNative } from "@/native";
import type { CompositorCodecSupport, CompositorGpuInfo } from "@/native/contracts";
import { buildNativeClipList } from "./ExportDialog";
import { ModalShell } from "./Modals";

/**
 * Settings → performance → video encoding device.
 *
 * Three states per card, and the difference between them is the whole point of this dialog:
 *
 *   - **Listed**: DXGI says the machine has it. Proves nothing about encoding.
 *   - **Has an encoder**: this ffmpeg build contains a matching encoder for the vendor. Still
 *     proves nothing — the AMF and NVENC back-ends are compiled in unconditionally, without the
 *     card behind them.
 *   - **Verified**: a real encode of a real clip went through it and produced a file. Only the
 *     test button can say this, which is why it writes a temp file and deletes it afterwards.
 *
 * "Not verified yet" is therefore the honest default, not a disabled state.
 */

interface EncoderSettingsDialogProps {
	open: boolean;
	onClose: () => void;
	document: AxcutDocument | null;
}

interface TestResult {
	device: string;
	ok: boolean;
	detail: string;
}

/** One second of the first visible clip: long enough to open the encoder and push real frames
 *  through it, short enough that the button feels like a test rather than an export. */
const TEST_SECONDS = 1;

/** The export dialog's default frame rate; the test uses it so bitrate and cadence match. */
const EXPORT_FPS = 60;

export function EncoderSettingsDialog({ open, onClose, document }: EncoderSettingsDialogProps) {
	const t = useScopedT("editor");
	const [gpus, setGpus] = useState<CompositorGpuInfo[] | null>(null);
	const [support, setSupport] = useState<CompositorCodecSupport | null>(null);
	const [device, setDevice] = useState("auto");
	const [codec, setCodec] = useState<VideoCodec>("h264");
	const [busy, setBusy] = useState(false);
	const [test, setTest] = useState<TestResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const [list, prefs, caps] = await Promise.all([
				listGpusNative().catch(() => [] as CompositorGpuInfo[]),
				window.electronAPI?.getEncoderPrefs?.().catch(() => ({ device: "auto", codec: "h264" })),
				codecSupportNative().catch(() => null),
			]);
			setGpus(list);
			setSupport(caps);
			if (prefs?.device) setDevice(prefs.device);
			setCodec(prefs?.codec === "hevc" ? "hevc" : "h264");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, []);

	useEffect(() => {
		if (open) void load();
	}, [open, load]);

	const choose = async (next: string) => {
		setDevice(next);
		// Persisted immediately: the point of a device setting is that it outlives the dialog,
		// the project, and the app.
		await window.electronAPI?.setEncoderPrefs?.({ device: next });
	};

	const chooseCodec = async (next: VideoCodec) => {
		setCodec(next);
		// The previous result belongs to the other format: keeping it on screen would show a
		// success for an encoder that was never asked to produce this one.
		setTest(null);
		await window.electronAPI?.setEncoderPrefs?.({ codec: next });
	};

	const runTest = async () => {
		const clips = document ? buildNativeClipList(document).slice(0, 1) : [];
		if (clips.length === 0) {
			setTest({ device, ok: false, detail: t("encoderSettings.noClipToTest") });
			return;
		}
		const [first] = clips;
		setBusy(true);
		setTest(null);
		try {
			// The stored value is `id:<PnP instance id>`, which the native layer does not accept —
			// it takes a runtime LUID. Resolving here is what the export path already does; this
			// button used to skip it, so testing a real card failed with "invalid encoder device"
			// while exporting with the same card worked.
			const choice = resolveEncoderDevice(device, gpus ?? [], codec, support);
			const result = await selfTestEncoderNative({
				clips: [
					{
						...first,
						sourceEndSec: Math.min(first.sourceEndSec, first.sourceStartSec + TEST_SECONDS),
					},
				],
				width: geometry?.width,
				height: geometry?.height,
				fps: geometry ? EXPORT_FPS : undefined,
				encoderDevice: choice.device,
				// The test produces the format being configured. Testing H.264 while the user picked
				// H.265 would report a success the export would never reproduce.
				codec,
			});
			setTest({
				device,
				ok: true,
				detail: `${t("encoderSettings.testOkDetail", {
					encoder: result.encoder ?? "?",
					adapter: result.adapter ?? "?",
					path: result.zeroCopy ? t("encoderSettings.zeroCopy") : t("encoderSettings.systemMemory"),
					frames: result.frames,
					ms: result.wallMs,
				})}${geometry ? ` · ${geometry.width}×${geometry.height}` : ""}`,
			});
		} catch (err) {
			setTest({ device, ok: false, detail: err instanceof Error ? err.message : String(err) });
		} finally {
			setBusy(false);
		}
	};

	// The size the export will actually produce. The test encodes at this size — a 1280x720 test
	// that passes while the 1598x1080 export fails is worse than no test at all.
	const geometry = document
		? resolveExportGeometry(
				document,
				"good",
				EXPORT_FPS,
				resolveAspectRatioValue(document, getEditorSettings(document).aspectRatio),
			)
		: null;

	const options = buildDeviceOptions(gpus ?? [], codec, support, geometry);
	// A stored legacy LUID is not an option value, but the card it names is still the selected one.
	const selectedLuid = resolveDeviceSelection(device, gpus ?? []).luid;
	// The chosen device may not carry the newly selected format. That is shown, not fixed
	// silently: switching the user's card because they changed the format is the same class of
	// bug as switching it because an encoder failed.
	const selectedCard = gpus?.find((gpu) => gpu.luid === selectedLuid);
	const selectedLacksFormat =
		Boolean(selectedCard) &&
		encodersForCodec(selectedCard as CompositorGpuInfo, codec).length === 0;
	// Chosen CPU for a format whose software encoder cannot take this size. Shown, not silently
	// switched: the export would refuse, so the dialog says why before the user tries.
	const cpuSizeBlocked =
		device === "cpu" && !softwareHevcSupportsSize(codec, geometry?.width, geometry?.height);

	return (
		<ModalShell
			open={open}
			onClose={onClose}
			wide
			title={t("encoderSettings.title")}
			subtitle={t("encoderSettings.subtitle")}
		>
			<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
				<div>
					<div style={{ ...sub, marginBottom: 6 }}>{t("encoderSettings.codecTitle")}</div>
					<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
						<FormatButton
							label={t("encoderSettings.codecH264")}
							hint={t("encoderSettings.codecH264Hint")}
							selected={codec === "h264"}
							onClick={() => void chooseCodec("h264")}
						/>
						<FormatButton
							label={t("encoderSettings.codecHevc")}
							hint={t("encoderSettings.codecHevcHint")}
							selected={codec === "hevc"}
							onClick={() => void chooseCodec("hevc")}
						/>
					</div>
					{cpuSizeBlocked && geometry ? (
						<div style={{ ...sub, color: "var(--warning, #d97706)", marginTop: 6 }}>
							{t("encoderSettings.reasonSoftwareSize", {
								size: `${geometry.width}×${geometry.height}`,
								block: "8",
							})}
						</div>
					) : null}
					{selectedLacksFormat ? (
						<div style={{ ...sub, color: "var(--warning, #d97706)", marginTop: 6 }}>
							{t("encoderSettings.codecUnavailable", {
								codec: codec === "hevc" ? "H.265/HEVC" : "H.264",
							})}
						</div>
					) : null}
				</div>

				<div style={{ display: "flex", gap: 8 }}>
					<button type="button" onClick={() => void load()} disabled={busy} style={secondaryButton}>
						<RefreshCw size={14} /> {t("encoderSettings.redetect")}
					</button>
					<button
						type="button"
						onClick={() => void runTest()}
						disabled={busy}
						style={primaryButton}
					>
						{busy ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
						{t("encoderSettings.test")}
					</button>
				</div>

				{error ? <div style={errorBox}>{error}</div> : null}

				<div
					role="radiogroup"
					aria-label={t("encoderSettings.title")}
					style={{ display: "grid", gap: 8 }}
				>
					{options.map((option) => (
						<DeviceRow
							key={option.device}
							option={option}
							codec={codec}
							selected={
								device === option.device || (Boolean(selectedLuid) && option.luid === selectedLuid)
							}
							test={test && test.device === option.device ? test : null}
							onSelect={() => void choose(option.device)}
							t={t}
						/>
					))}
				</div>

				{gpus === null ? (
					<div style={hint}>{t("encoderSettings.detecting")}</div>
				) : gpus.length === 0 ? (
					<div style={hint}>{t("encoderSettings.noDevices")}</div>
				) : null}

				<div style={hint}>{t("encoderSettings.persistHint")}</div>
			</div>
		</ModalShell>
	);
}

function FormatButton({
	label,
	hint,
	selected,
	onClick,
}: {
	label: string;
	hint: string;
	selected: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={selected}
			onClick={onClick}
			style={{
				display: "grid",
				gap: 2,
				textAlign: "left",
				padding: "8px 12px",
				borderRadius: 9,
				border: `1px solid ${selected ? "var(--accent, #6366f1)" : "var(--border-soft, #2a2a30)"}`,
				background: selected ? "rgba(99,102,241,0.10)" : "transparent",
				color: "inherit",
				cursor: "pointer",
			}}
		>
			<strong style={{ fontSize: 13, fontWeight: 600 }}>{label}</strong>
			<span style={{ fontSize: 11, color: "var(--text-muted, #a1a1aa)" }}>{hint}</span>
		</button>
	);
}

function DeviceRow({
	option,
	codec,
	selected,
	test,
	onSelect,
	t,
}: {
	option: EncoderDeviceOption;
	codec: VideoCodec;
	selected: boolean;
	test: TestResult | null;
	onSelect: () => void;
	t: (key: string, vars?: Record<string, string | number>) => string;
}) {
	const disabled = !option.selectable;
	return (
		<button
			type="button"
			role="radio"
			aria-checked={selected}
			aria-disabled={disabled}
			disabled={disabled}
			onClick={onSelect}
			style={{
				display: "grid",
				gridTemplateColumns: "auto 1fr",
				gap: 12,
				alignItems: "start",
				textAlign: "left",
				padding: "12px 14px",
				borderRadius: 10,
				border: `1px solid ${selected ? "var(--accent, #6366f1)" : "var(--border-soft, #2a2a30)"}`,
				background: selected ? "rgba(99,102,241,0.10)" : "transparent",
				color: "inherit",
				cursor: disabled ? "not-allowed" : "pointer",
				opacity: disabled ? 0.55 : 1,
			}}
		>
			<span style={{ paddingTop: 2, color: "var(--text-muted, #8b8b93)" }}>
				{option.kind === "gpu" ? <MonitorCog size={16} /> : <Cpu size={16} />}
			</span>
			<span style={{ display: "grid", gap: 4 }}>
				<span style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
					<strong style={{ fontWeight: 600 }}>{option.label}</strong>
					{option.vendor && option.kind === "gpu" ? <span style={tag}>{option.vendor}</span> : null}
					{option.duplicates && option.duplicates > 1 ? (
						<span style={tag}>
							{t("encoderSettings.duplicateEntries", { count: option.duplicates })}
						</span>
					) : null}
				</span>

				{option.kind === "auto" ? <span style={sub}>{t("encoderSettings.autoHint")}</span> : null}
				{option.kind === "cpu" ? <span style={sub}>{t("encoderSettings.cpuHint")}</span> : null}
				{option.kind === "gpu" ? (
					// Both formats on their own line: a card that encodes H.264 is not thereby a
					// card that encodes HEVC, and one merged line is how that gets believed.
					<span style={sub}>
						{[
							["H.264", option.h264Encoders ?? [], "h264"],
							["H.265", option.hevcEncoders ?? [], "hevc"],
						].map(([label, list, which]) => (
							<span
								key={String(label)}
								style={{
									display: "block",
									fontWeight: codec === which ? 600 : 400,
									color: codec === which ? "inherit" : "var(--text-muted, #a1a1aa)",
								}}
							>
								{String(label)}:{" "}
								{(list as string[]).length > 0
									? (list as string[]).join(" · ")
									: t("encoderSettings.noEncoder")}
							</span>
						))}
					</span>
				) : null}

				{option.kind === "gpu" && option.stableId ? (
					// The identity that is actually stored, and the handle that is only good for this
					// session — side by side, because confusing them is what V2.2 did.
					<span style={identLine}>
						{t("encoderSettings.stableId")}: {option.stableId}
						{option.identityAmbiguous ? ` (${t("encoderSettings.ambiguousIdentity")})` : ""}
						{option.luid ? ` · ${t("encoderSettings.runtimeLuid")}: ${option.luid}` : ""}
					</span>
				) : null}

				{option.disabledReason ? (
					<span style={{ ...sub, color: "var(--warning, #d97706)" }}>
						{t(option.disabledReason.key, option.disabledReason.vars)}
					</span>
				) : null}

				{test ? (
					<span
						style={{
							...sub,
							color: test.ok ? "var(--success, #16a34a)" : "var(--danger, #dc2626)",
						}}
					>
						{test.ok ? "✓ " : "✕ "}
						{test.detail}
					</span>
				) : null}
			</span>
		</button>
	);
}

const tag: React.CSSProperties = {
	fontSize: 11,
	padding: "1px 6px",
	borderRadius: 4,
	background: "var(--surface-3, #26262c)",
	color: "var(--text-muted, #a1a1aa)",
};
const sub: React.CSSProperties = {
	fontSize: 12,
	color: "var(--text-muted, #a1a1aa)",
	lineHeight: 1.5,
};
const identLine: React.CSSProperties = {
	fontSize: 10.5,
	fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
	color: "var(--text-muted, #71717a)",
	overflowWrap: "anywhere",
	lineHeight: 1.45,
};
const hint: React.CSSProperties = { fontSize: 12, color: "var(--text-muted, #71717a)" };
const errorBox: React.CSSProperties = {
	fontSize: 12,
	padding: "8px 10px",
	borderRadius: 8,
	background: "rgba(220,38,38,0.12)",
	color: "var(--danger, #f87171)",
};
const primaryButton: React.CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	padding: "7px 12px",
	borderRadius: 8,
	border: "1px solid var(--border-soft, #2a2a30)",
	background: "var(--accent, #6366f1)",
	color: "#fff",
	fontSize: 12,
	cursor: "pointer",
};
const secondaryButton: React.CSSProperties = {
	...primaryButton,
	background: "transparent",
	color: "inherit",
};
