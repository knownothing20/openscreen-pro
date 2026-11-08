import type { CompositorGpuInfo } from "@/native/contracts";

/**
 * Turning the adapter list into something a person can choose from.
 *
 * Two problems this solves, both observed on a real machine rather than imagined:
 *
 *  1. DXGI reports the SAME physical card more than once. On the machine this was built on it
 *     lists the RTX 4070 Ti SUPER twice and the Radeon 780M twice, with different LUIDs. Six
 *     entries, two cards. A settings list that shows all six is a list a user cannot reason about,
 *     so duplicates collapse onto the first entry — the LUID that stays is the one whose device
 *     creation is attempted first anyway.
 *  2. Software adapters (WARP, RDP, virtual displays) must be SHOWN and marked, not hidden: "why
 *     is my GPU not in the list" is a worse question than "Intel GPU — no hardware encoder".
 */

export interface EncoderDeviceOption {
	/** What gets persisted: "auto", "cpu", or an adapter LUID in hex. */
	device: string;
	kind: "auto" | "cpu" | "gpu";
	label: string;
	vendor?: string;
	luid?: string;
	encoders?: string[];
	/** False for a software/virtual adapter: listed, explained, not chooseable. */
	selectable: boolean;
	/** Why it cannot be chosen, when it cannot. */
	disabledReason?: string;
	/** How many raw DXGI entries collapsed into this one (>1 means the driver duplicated it). */
	duplicates?: number;
}

/** Identity of a physical card, as opposed to a DXGI adapter entry. */
function hardwareKey(gpu: CompositorGpuInfo): string {
	return `${gpu.vendorId}:${gpu.deviceId}:${gpu.name}`;
}

/** Raw adapters collapsed onto one entry per physical card, first LUID wins. */
export function groupAdapters(gpus: readonly CompositorGpuInfo[]): Array<{
	gpu: CompositorGpuInfo;
	duplicates: number;
}> {
	const seen = new Map<string, { gpu: CompositorGpuInfo; duplicates: number }>();
	for (const gpu of gpus) {
		const key = hardwareKey(gpu);
		const existing = seen.get(key);
		if (existing) {
			existing.duplicates += 1;
			continue;
		}
		seen.set(key, { gpu, duplicates: 1 });
	}
	return [...seen.values()];
}

/** The full list the settings screen renders, in the order it renders it. */
export function buildDeviceOptions(gpus: readonly CompositorGpuInfo[]): EncoderDeviceOption[] {
	const options: EncoderDeviceOption[] = [
		{
			device: "auto",
			kind: "auto",
			label: "Auto",
			selectable: true,
			encoders: [],
		},
	];

	for (const { gpu, duplicates } of groupAdapters(gpus)) {
		const usable = !gpu.software && gpu.encoders.length > 0;
		options.push({
			device: gpu.luid,
			kind: "gpu",
			label: gpu.name,
			vendor: gpu.vendor,
			luid: gpu.luid,
			encoders: gpu.encoders,
			selectable: usable,
			disabledReason: gpu.software
				? "Software adapter — it can composite, but it has no hardware encoder."
				: gpu.encoders.length === 0
					? "No encoder for this vendor in this build."
					: undefined,
			duplicates,
		});
	}

	options.push({
		device: "cpu",
		kind: "cpu",
		label: "CPU (software encoding)",
		selectable: true,
		encoders: [],
	});

	return options;
}

/**
 * What the export status line should say about the stored choice.
 *
 * A device that is no longer present is not silently turned into "auto": the user picked a card,
 * the card is gone (undocked, driver rolled back), and the honest answer is to say so — the export
 * will then run with Auto and report its own fallback, which is visible in the same line.
 */
export function describeStoredChoice(
	device: string,
	gpus: readonly CompositorGpuInfo[],
): { label: string; missing: boolean } {
	if (device === "auto") return { label: "Auto", missing: false };
	if (device === "cpu") return { label: "CPU (software encoding)", missing: false };
	const match = gpus.find((gpu) => gpu.luid.toLowerCase() === device.toLowerCase());
	if (!match) return { label: `Unavailable adapter (${device})`, missing: true };
	return { label: match.name, missing: false };
}

/** Whether the encoder that ran was the one the device implies. */
export function encoderMatchesVendor(
	encoder: string | undefined,
	vendorId: number | undefined,
): boolean {
	if (!encoder || vendorId === undefined) return true;
	const expected = encoder.endsWith("_nvenc")
		? 0x10de
		: encoder.endsWith("_amf")
			? 0x1002
			: encoder.endsWith("_qsv")
				? 0x8086
				: undefined;
	// A software encoder is always "not contradicting" the vendor: it is the documented fallback.
	return expected === undefined || expected === vendorId;
}
