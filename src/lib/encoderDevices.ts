import type { CompositorCodecSupport, CompositorGpuInfo } from "@/native/contracts";

/** The two formats this app produces. `hevc` is what the native layer calls `h265`. */
export type VideoCodec = "h264" | "hevc";

/** The encoders one card carries for one format. Never the union of both. */
export function encodersForCodec(gpu: CompositorGpuInfo, codec: VideoCodec): readonly string[] {
	return codec === "hevc" ? gpu.encodersHevc : gpu.encodersH264;
}

/** Whether the CPU can encode this format at all — a software encoder must actually exist. */
export function cpuSupportsCodec(
	codec: VideoCodec,
	support: CompositorCodecSupport | null | undefined,
): boolean {
	// Without an answer from the native side, do not block the choice: the export will report the
	// real failure, and a missing addon entry should not make the setting look broken.
	if (!support) return true;
	return codec === "hevc" ? support.hevcSoftware : support.h264Software;
}

/**
 * Turning the adapter list into something a person can choose from, and resolving the choice back
 * into a runtime device.
 *
 * Three problems, all of them observed rather than imagined:
 *
 *  1. DXGI reports the SAME physical card more than once (two entries, different LUIDs, on the
 *     machine this was built on). A list of six adapters for two cards is a list nobody can reason
 *     about, so entries collapse on the **PnP device instance id** — never on name or device id,
 *     which is exactly what two identical cards share.
 *  2. Two identical cards share that stable id too. Then merging would hide a real choice, so the
 *     entries stay separate and say the identity is ambiguous.
 *  3. Software adapters (WARP, RDP, virtual displays) must be SHOWN and marked, not hidden:
 *     "why is my GPU not in the list" is a worse question than "no hardware encoder".
 *
 * The stored value names a device that survives reboots; the LUID it resolves to does not, and is
 * only ever used for the duration of one export.
 */

export interface EncoderDeviceOption {
	/** What gets persisted: "auto", "cpu", or `id:<stableId>`. */
	device: string;
	kind: "auto" | "cpu" | "gpu";
	label: string;
	vendor?: string;
	/** PnP instance id, when the entry has one. */
	stableId?: string;
	/** Runtime handle, shown for diagnostics; never persisted. */
	luid?: string;
	/** Encoders for the format being shown. */
	encoders?: string[];
	/** Both formats, so one row can state what the card does for each. */
	h264Encoders?: string[];
	hevcEncoders?: string[];
	/** False for a software/virtual adapter: listed, explained, not chooseable. */
	selectable: boolean;
	/**
	 * Why it cannot be chosen, when it cannot — as an i18n key plus its variables, not prose.
	 *
	 * This module has no translator, and a hardcoded English sentence was showing up verbatim in
	 * every non-English UI (the settings list mixed languages in the same row).
	 */
	disabledReason?: { key: string; vars?: Record<string, string> };
	/** How many raw DXGI entries collapsed into this one (>1 means the driver duplicated it). */
	duplicates?: number;
	/** True when the stable id is a model-level key shared with another card. */
	identityAmbiguous?: boolean;
}

/**
 * Grouping key: the physical card.
 *
 * A non-ambiguous stable id is the card. An ambiguous one is a *model*, so it is suffixed with the
 * LUID to keep the entries apart — merging two identical cards would make the list lie about how
 * many there are.
 */
function groupKey(gpu: CompositorGpuInfo): string {
	return gpu.identityAmbiguous ? `${gpu.stableId}#${gpu.luid}` : gpu.stableId;
}

/** Raw adapters collapsed onto one entry per physical card, first LUID wins. */
export function groupAdapters(gpus: readonly CompositorGpuInfo[]): Array<{
	gpu: CompositorGpuInfo;
	duplicates: number;
}> {
	const seen = new Map<string, { gpu: CompositorGpuInfo; duplicates: number }>();
	for (const gpu of gpus) {
		const key = groupKey(gpu);
		const existing = seen.get(key);
		if (existing) {
			existing.duplicates += 1;
			continue;
		}
		seen.set(key, { gpu, duplicates: 1 });
	}
	return [...seen.values()];
}

/** The value a GPU entry persists. */
export function deviceIdFor(gpu: CompositorGpuInfo): string {
	return `id:${gpu.stableId}`;
}

/**
 * The full list the settings screen renders, for one format.
 *
 * Per format, because availability is: a card can carry `h264_nvenc` and no `hevc_nvenc`, and a
 * list that merges them says "this card encodes HEVC" about a card that cannot.
 */
export function buildDeviceOptions(
	gpus: readonly CompositorGpuInfo[],
	codec: VideoCodec = "h264",
	support?: CompositorCodecSupport | null,
): EncoderDeviceOption[] {
	const options: EncoderDeviceOption[] = [
		{ device: "auto", kind: "auto", label: "Auto", selectable: true, encoders: [] },
	];

	for (const { gpu, duplicates } of groupAdapters(gpus)) {
		const encoders = [...encodersForCodec(gpu, codec)];
		const usable = !gpu.software && encoders.length > 0;
		options.push({
			device: deviceIdFor(gpu),
			kind: "gpu",
			label: gpu.name,
			vendor: gpu.vendor,
			stableId: gpu.stableId,
			luid: gpu.luid,
			encoders,
			h264Encoders: [...gpu.encodersH264],
			hevcEncoders: [...gpu.encodersHevc],
			selectable: usable,
			disabledReason: gpu.software
				? { key: "encoderSettings.reasonSoftwareAdapter" }
				: encoders.length === 0
					? {
							key: "encoderSettings.reasonNoVendorEncoder",
							vars: { codec: codec === "hevc" ? "H.265/HEVC" : "H.264" },
						}
					: undefined,
			duplicates,
			identityAmbiguous: gpu.identityAmbiguous,
		});
	}

	const cpuUsable = cpuSupportsCodec(codec, support);
	options.push({
		device: "cpu",
		kind: "cpu",
		label: "CPU (software encoding)",
		selectable: cpuUsable,
		disabledReason: cpuUsable
			? undefined
			: {
					key: "encoderSettings.reasonNoSoftwareEncoder",
					vars: { codec: codec === "hevc" ? "H.265/HEVC" : "H.264" },
				},
		encoders: [],
	});

	return options;
}

export type DeviceProblem = "not-found" | "ambiguous";

export interface ResolvedDevice {
	mode: "auto" | "cpu" | "gpu";
	/** Runtime handle to give the encoder. Absent for auto/cpu, or when unresolved. */
	luid?: string;
	stableId?: string;
	label: string;
	/** Set when a legacy LUID resolved: the caller should persist this instead. */
	migratedTo?: string;
	/** Present when the stored GPU cannot be used right now. The caller must FAIL, not fall back:
	 *  silently encoding on another card is the bug this whole model exists to prevent. */
	problem?: DeviceProblem;
}

/**
 * Stored choice → what to actually run.
 *
 * `auto` and `cpu` pass through. A GPU is stored as `id:<stableId>` and is looked up by that id;
 * a bare hex string is a V2.2 LUID, kept working (and reported as `migratedTo`) so the upgrade does
 * not throw away a working choice. A device that is gone stays a FAILURE — the settings screen keeps
 * showing what the user picked, and the export says the card is not there.
 */
export function resolveDeviceSelection(
	stored: string,
	gpus: readonly CompositorGpuInfo[],
): ResolvedDevice {
	const value = (stored ?? "").trim();
	if (value === "" || value === "auto") {
		return { mode: "auto", label: "Auto" };
	}
	if (value === "cpu") {
		return { mode: "cpu", label: "CPU (software encoding)" };
	}

	if (value.startsWith("id:")) {
		const stableId = value.slice(3);
		const match = gpus.find((gpu) => gpu.stableId === stableId);
		if (!match) {
			return { mode: "gpu", stableId, label: stableId, problem: "not-found" };
		}
		// `identityAmbiguous` is the native side saying "this id names a model, not a device" —
		// two identical cards, or an adapter with no PCI identity. Several entries sharing a
		// NON-ambiguous id are just the driver listing one card twice, which is fine.
		// Pretending an ambiguous id pins a device would pick one of two cards at random.
		if (match.identityAmbiguous) {
			return {
				mode: "gpu",
				stableId,
				luid: match.luid,
				label: match.name,
				problem: "ambiguous",
			};
		}
		return { mode: "gpu", stableId, luid: match.luid, label: match.name };
	}

	// Legacy: a bare LUID, as V2.2 stored it. Resolve once and hand back the value to migrate to.
	const byLuid = gpus.find((gpu) => gpu.luid.toLowerCase() === value.toLowerCase());
	if (byLuid) {
		return {
			mode: "gpu",
			stableId: byLuid.stableId,
			luid: byLuid.luid,
			label: byLuid.name,
			migratedTo: deviceIdFor(byLuid),
		};
	}
	return { mode: "gpu", label: value, problem: "not-found" };
}

/**
 * What the export line should say about the stored choice, without pretending it resolved.
 * `missing` is what the export acts on: it refuses rather than picking another card.
 */
export function describeStoredChoice(
	device: string,
	gpus: readonly CompositorGpuInfo[],
): { label: string; missing: boolean } {
	const resolved = resolveDeviceSelection(device, gpus);
	if (resolved.mode !== "gpu") return { label: resolved.label, missing: false };
	if (resolved.problem) {
		return {
			label: `Unavailable device (${resolved.stableId ?? resolved.label})`,
			missing: true,
		};
	}
	return { label: resolved.label, missing: false };
}

/**
 * The value to hand the encoder, or a thrown error explaining why there is none.
 *
 * Throwing is the point: a manual choice that cannot be honoured must stop the export, not quietly
 * encode on another card. The settings screen keeps showing what the user picked either way.
 */
export function resolveEncoderDevice(
	stored: string,
	gpus: readonly CompositorGpuInfo[],
	codec: VideoCodec = "h264",
	support?: CompositorCodecSupport | null,
): { device: string; label: string; migratedTo?: string } {
	const resolved = resolveDeviceSelection(stored, gpus);
	if (resolved.mode === "auto") return { device: "auto", label: resolved.label };
	if (resolved.mode === "cpu") {
		// Not an H.264 fallback: the user asked for a format, and a build with no software encoder
		// for it cannot produce that format at all.
		if (!cpuSupportsCodec(codec, support)) {
			throw new Error(
				`This build has no software ${codec === "hevc" ? "HEVC" : "H.264"} encoder, so CPU encoding ` +
					"cannot produce that format. Choose Auto, or a GPU that supports it.",
			);
		}
		return { device: "cpu", label: resolved.label };
	}
	if (resolved.problem === "not-found") {
		throw new Error(
			`The selected encoder device is not present on this machine (${resolved.stableId ?? stored}). ` +
				"Open Settings → Video encoding device and pick again, or choose Auto.",
		);
	}
	if (resolved.problem === "ambiguous") {
		throw new Error(
			`The selected encoder device matches more than one card (${resolved.stableId}), so it cannot be ` +
				"pinned. Choose Auto, or CPU (software encoding).",
		);
	}
	if (!resolved.luid) {
		throw new Error("The selected encoder device did not resolve to a usable device.");
	}
	// A card without an encoder for the requested format is a real answer ("this card cannot
	// encode HEVC"), and the export must say so rather than hand the pipeline a vendor it will
	// then fail on — or, worse, let it use somebody else's encoder.
	const card = gpus.find((gpu) => gpu.luid === resolved.luid);
	if (card && encodersForCodec(card, codec).length === 0) {
		throw new Error(
			`${card.name} has no ${codec === "hevc" ? "HEVC" : "H.264"} encoder in this build. ` +
				"Pick another device, or switch the format.",
		);
	}
	return { device: resolved.luid, label: resolved.label, migratedTo: resolved.migratedTo };
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
