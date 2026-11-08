import { describe, expect, it } from "vitest";
import type { CompositorGpuInfo } from "@/native/contracts";
import {
	buildDeviceOptions,
	describeStoredChoice,
	encoderMatchesVendor,
	groupAdapters,
	resolveDeviceSelection,
	resolveEncoderDevice,
} from "./encoderDevices";

/**
 * The fixture is the real output of `listGpus()` on the machine this was built on: six DXGI
 * entries, two physical cards, plus two WARP adapters. The two NVIDIA entries are the SAME card
 * exposed twice (different LUID, identical PnP instance id) — that duplication is what the
 * grouping has to survive.
 */
const NVIDIA_ID = "PCI\\VEN_10DE&DEV_2705&SUBSYS_413C1458&REV_A1\\4&25C6DA53&0&0009";
const AMD_ID = "PCI\\VEN_1002&DEV_1900&SUBSYS_01241002&REV_BA\\4&98C338A&0&0041";
const WARP_ID = "pci:VEN_1414&DEV_008C&SUBSYS_00000000&REV_00";

const GPU: CompositorGpuInfo[] = [
	{
		index: 0,
		name: "AMD Radeon 780M Graphics",
		vendor: "AMD",
		vendorId: 0x1002,
		deviceId: 0x1900,
		stableId: AMD_ID,
		identityAmbiguous: false,
		luid: "0000000000013f81",
		dedicatedVramMb: 512,
		software: false,
		encoders: ["h264_amf", "hevc_amf"],
	},
	{
		index: 1,
		name: "NVIDIA GeForce RTX 4070 Ti SUPER",
		vendor: "NVIDIA",
		vendorId: 0x10de,
		deviceId: 0x2705,
		stableId: NVIDIA_ID,
		identityAmbiguous: false,
		luid: "000000000438724d",
		dedicatedVramMb: 16063,
		software: false,
		encoders: ["h264_nvenc", "hevc_nvenc"],
	},
	{
		index: 2,
		name: "NVIDIA GeForce RTX 4070 Ti SUPER",
		vendor: "NVIDIA",
		vendorId: 0x10de,
		deviceId: 0x2705,
		stableId: NVIDIA_ID,
		identityAmbiguous: false,
		luid: "00000000000209c0",
		dedicatedVramMb: 16063,
		software: false,
		encoders: ["h264_nvenc", "hevc_nvenc"],
	},
	{
		index: 3,
		name: "AMD Radeon 780M Graphics",
		vendor: "AMD",
		vendorId: 0x1002,
		deviceId: 0x1900,
		stableId: AMD_ID,
		identityAmbiguous: false,
		luid: "000000017516a0ec",
		dedicatedVramMb: 512,
		software: false,
		encoders: ["h264_amf", "hevc_amf"],
	},
	{
		index: 4,
		name: "Microsoft Basic Render Driver",
		vendor: "Microsoft",
		vendorId: 0x1414,
		deviceId: 0x8c,
		stableId: WARP_ID,
		identityAmbiguous: true,
		luid: "0000000000015c10",
		dedicatedVramMb: 0,
		software: true,
		encoders: [],
	},
	{
		index: 5,
		name: "Microsoft Basic Render Driver",
		vendor: "Microsoft",
		vendorId: 0x1414,
		deviceId: 0x8c,
		stableId: WARP_ID,
		identityAmbiguous: true,
		luid: "0000000000015c61",
		dedicatedVramMb: 0,
		software: true,
		encoders: [],
	},
];

describe("groupAdapters", () => {
	it("collapses the duplicated DXGI entries of one card onto one entry", () => {
		const groups = groupAdapters(GPU);
		const nvidia = groups.filter((group) => group.gpu.vendor === "NVIDIA");
		expect(nvidia).toHaveLength(1);
		expect(nvidia[0].duplicates).toBe(2);
		// The first LUID is kept: that is the one device creation is asked for.
		expect(nvidia[0].gpu.luid).toBe("000000000438724d");
	});

	it("keeps two cards of the same model apart when the identity is ambiguous", () => {
		const twins: CompositorGpuInfo[] = [
			{ ...GPU[1], identityAmbiguous: true, luid: "aaaa" },
			{ ...GPU[1], identityAmbiguous: true, luid: "bbbb" },
		];
		// Same stable id, but it only names the model — merging would claim there is one card.
		expect(groupAdapters(twins)).toHaveLength(2);
	});
});

describe("buildDeviceOptions", () => {
	const options = buildDeviceOptions(GPU);

	it("stores the stable id, never the LUID", () => {
		const nvidia = options.find((option) => option.vendor === "NVIDIA");
		expect(nvidia?.device).toBe(`id:${NVIDIA_ID}`);
		expect(nvidia?.device).not.toContain("0438724d");
	});

	it("offers Auto first and CPU last", () => {
		expect(options[0].kind).toBe("auto");
		expect(options.at(-1)?.kind).toBe("cpu");
	});

	it("marks a software adapter as shown-but-not-chooseable, with the reason", () => {
		const warp = options.find((option) => option.label === "Microsoft Basic Render Driver");
		expect(warp?.selectable).toBe(false);
		expect(warp?.disabledReason).toMatch(/software adapter/i);
	});
});

describe("resolveDeviceSelection", () => {
	it("passes auto and cpu through", () => {
		expect(resolveDeviceSelection("auto", GPU).mode).toBe("auto");
		expect(resolveDeviceSelection("cpu", GPU).mode).toBe("cpu");
	});

	it("resolves a stable id to the current LUID", () => {
		const resolved = resolveDeviceSelection(`id:${NVIDIA_ID}`, GPU);
		expect(resolved.mode).toBe("gpu");
		expect(resolved.luid).toBe("000000000438724d");
		expect(resolved.problem).toBeUndefined();
	});

	it("fails a stable id that is not on this machine instead of falling back to auto", () => {
		const resolved = resolveDeviceSelection(
			"id:PCI\\VEN_10DE&DEV_9999&SUBSYS_DEADBEEF&REV_A1\\x",
			GPU,
		);
		expect(resolved.problem).toBe("not-found");
		// No LUID means the export cannot silently run somewhere else.
		expect(resolved.luid).toBeUndefined();
	});

	it("migrates a legacy LUID that still resolves, and says what to store instead", () => {
		const resolved = resolveDeviceSelection("000000000438724d", GPU);
		expect(resolved.luid).toBe("000000000438724d");
		expect(resolved.migratedTo).toBe(`id:${NVIDIA_ID}`);
	});

	it("fails a legacy LUID that no longer exists", () => {
		expect(resolveDeviceSelection("deadbeefdeadbeef", GPU).problem).toBe("not-found");
	});

	it("reports ambiguity rather than picking one of two identical cards", () => {
		const twins: CompositorGpuInfo[] = [
			{ ...GPU[1], identityAmbiguous: true, luid: "aaaa" },
			{ ...GPU[1], identityAmbiguous: true, luid: "bbbb" },
		];
		expect(resolveDeviceSelection(`id:${NVIDIA_ID}`, twins).problem).toBe("ambiguous");
	});

	it("treats an unreadable value as auto — a corrupt file must not brick exports", () => {
		expect(resolveDeviceSelection("", GPU).mode).toBe("auto");
	});
});

describe("describeStoredChoice", () => {
	it("names the card a stable id points at", () => {
		expect(describeStoredChoice(`id:${NVIDIA_ID}`, GPU)).toEqual({
			label: "NVIDIA GeForce RTX 4070 Ti SUPER",
			missing: false,
		});
	});

	it("reports a card that is gone instead of pretending it is Auto", () => {
		const gone = describeStoredChoice("id:PCI\\VEN_10DE&DEV_9999&SUBSYS_DEADBEEF&REV_A1\\x", GPU);
		expect(gone.missing).toBe(true);
	});
});

describe("encoderMatchesVendor", () => {
	it("accepts the vendor's own encoder", () => {
		expect(encoderMatchesVendor("h264_nvenc", 0x10de)).toBe(true);
		expect(encoderMatchesVendor("h264_amf", 0x1002)).toBe(true);
	});

	it("flags an encoder from the wrong vendor", () => {
		expect(encoderMatchesVendor("h264_amf", 0x10de)).toBe(false);
	});

	it("does not judge a software encoder", () => {
		expect(encoderMatchesVendor("libopenh264", 0x10de)).toBe(true);
		expect(encoderMatchesVendor(undefined, 0x10de)).toBe(true);
	});
});

describe("resolveEncoderDevice — manual choices fail loudly", () => {
	it("returns the LUID for a card that is present", () => {
		expect(resolveEncoderDevice(`id:${NVIDIA_ID}`, GPU).device).toBe("000000000438724d");
	});

	it("throws for a card that is gone, naming it", () => {
		expect(() =>
			resolveEncoderDevice("id:PCI\\VEN_10DE&DEV_9999&SUBSYS_DEADBEEF&REV_A1\\x", GPU),
		).toThrow(/not present/);
	});

	it("throws rather than guessing between two identical cards", () => {
		const twins: CompositorGpuInfo[] = [
			{ ...GPU[1], identityAmbiguous: true, luid: "aaaa" },
			{ ...GPU[1], identityAmbiguous: true, luid: "bbbb" },
		];
		expect(() => resolveEncoderDevice(`id:${NVIDIA_ID}`, twins)).toThrow(/more than one card/);
	});

	it("passes auto and cpu through unchanged", () => {
		expect(resolveEncoderDevice("auto", GPU).device).toBe("auto");
		expect(resolveEncoderDevice("cpu", GPU).device).toBe("cpu");
	});
});
