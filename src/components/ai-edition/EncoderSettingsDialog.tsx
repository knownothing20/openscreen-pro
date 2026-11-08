import { Cpu, Loader2, MonitorCog, RefreshCw, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { buildDeviceOptions, type EncoderDeviceOption } from "@/lib/encoderDevices";
import { listGpusNative, selfTestEncoderNative } from "@/native";
import type { CompositorGpuInfo } from "@/native/contracts";
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

export function EncoderSettingsDialog({ open, onClose, document }: EncoderSettingsDialogProps) {
	const t = useScopedT("editor");
	const [gpus, setGpus] = useState<CompositorGpuInfo[] | null>(null);
	const [device, setDevice] = useState("auto");
	const [busy, setBusy] = useState(false);
	const [test, setTest] = useState<TestResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const [list, prefs] = await Promise.all([
				listGpusNative().catch(() => [] as CompositorGpuInfo[]),
				window.electronAPI?.getEncoderPrefs?.().catch(() => ({ device: "auto" })),
			]);
			setGpus(list);
			if (prefs?.device) setDevice(prefs.device);
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
			const result = await selfTestEncoderNative({
				clips: [
					{
						...first,
						sourceEndSec: Math.min(first.sourceEndSec, first.sourceStartSec + TEST_SECONDS),
					},
				],
				width: 1280,
				height: 720,
				fps: 30,
				encoderDevice: device,
			});
			setTest({
				device,
				ok: true,
				detail: t("encoderSettings.testOkDetail", {
					encoder: result.encoder ?? "?",
					adapter: result.adapter ?? "?",
					path: result.zeroCopy ? t("encoderSettings.zeroCopy") : t("encoderSettings.systemMemory"),
					frames: result.frames,
					ms: result.wallMs,
				}),
			});
		} catch (err) {
			setTest({ device, ok: false, detail: err instanceof Error ? err.message : String(err) });
		} finally {
			setBusy(false);
		}
	};

	const options = buildDeviceOptions(gpus ?? []);

	return (
		<ModalShell
			open={open}
			onClose={onClose}
			wide
			title={t("encoderSettings.title")}
			subtitle={t("encoderSettings.subtitle")}
		>
			<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
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
							selected={device === option.device}
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

function DeviceRow({
	option,
	selected,
	test,
	onSelect,
	t,
}: {
	option: EncoderDeviceOption;
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
					<span style={sub}>
						{option.encoders && option.encoders.length > 0
							? option.encoders.join(" · ")
							: t("encoderSettings.noEncoder")}
					</span>
				) : null}

				{option.disabledReason ? (
					<span style={{ ...sub, color: "var(--warning, #d97706)" }}>{option.disabledReason}</span>
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
