import { describe, expect, it } from "vitest";
import type { CompositorGpuInfo } from "@/native/contracts";
import {
	buildDeviceOptions,
	describeStoredChoice,
	encoderMatchesVendor,
	groupAdapters,
} from "./encoderDevices";

/**
 * The fixture is the real output of `listGpus()` on the machine this was built on: six DXGI
 * entries for two physical cards, plus two WARP adapters. Writing it down as data is the point —
 * the duplicate entries are not hypothetical, they are what a user would have seen in the list.
 */
const GPU: CompositorGpuInfo[] = [
	{
		index: 0,
		name: "AMD Radeon 780M Graphics",
		vendor: "AMD",
		vendorId: 0x1002,
		deviceId: 0x1900,
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
		luid: "0000000000015c61",
		dedicatedVramMb: 0,
		software: true,
		encoders: [],
	},
];

describe("groupAdapters", () => {
	it("collapses the duplicate DXGI entries onto one card each", () => {
		const groups = groupAdapters(GPU);
		expect(groups).toHaveLength(3);
		expect(groups.map((g) => g.gpu.name)).toEqual([
			"AMD Radeon 780M Graphics",
			"NVIDIA GeForce RTX 4070 Ti SUPER",
			"Microsoft Basic Render Driver",
		]);
		// The first LUID is the one kept: it is the one device creation will be asked for.
		expect(groups[1].gpu.luid).toBe("000000000438724d");
		expect(groups[1].duplicates).toBe(2);
	});

	it("keeps two cards of the same model apart when they are different hardware", () => {
		const twins = [
			{ ...GPU[1], luid: "aaaa" },
			{ ...GPU[1], luid: "bbbb", deviceId: 0x2706 },
		];
		expect(groupAdapters(twins)).toHaveLength(2);
	});
});

describe("buildDeviceOptions", () => {
	const options = buildDeviceOptions(GPU);

	it("offers Auto first and CPU last, with the cards in between", () => {
		expect(options[0].kind).toBe("auto");
		expect(options.at(-1)?.kind).toBe("cpu");
		expect(options.filter((o) => o.kind === "gpu")).toHaveLength(3);
	});

	it("marks a software adapter as shown-but-not-chooseable, with the reason", () => {
		const warp = options.find((o) => o.label === "Microsoft Basic Render Driver");
		expect(warp).toBeDefined();
		expect(warp?.selectable).toBe(false);
		expect(warp?.disabledReason).toMatch(/software adapter/i);
	});

	it("marks a card with no encoder as not chooseable, and says why", () => {
		const opts = buildDeviceOptions([{ ...GPU[0], encoders: [] }]);
		const amd = opts.find((o) => o.kind === "gpu");
		expect(amd?.selectable).toBe(false);
		expect(amd?.disabledReason).toMatch(/no encoder/i);
	});

	it("stores the LUID, never the enumeration index", () => {
		const nvidia = options.find((o) => o.vendor === "NVIDIA");
		expect(nvidia?.device).toBe("000000000438724d");
	});
});

describe("describeStoredChoice", () => {
	it("names the card the user picked", () => {
		expect(describeStoredChoice("000000000438724d", GPU)).toEqual({
			label: "NVIDIA GeForce RTX 4070 Ti SUPER",
			missing: false,
		});
	});

	it("reports a card that is no longer installed instead of pretending it is Auto", () => {
		const gone = describeStoredChoice("deadbeefdeadbeef", GPU);
		expect(gone.missing).toBe(true);
		expect(gone.label).toContain("deadbeefdeadbeef");
	});

	it("passes the two explicit choices through", () => {
		expect(describeStoredChoice("auto", GPU).label).toBe("Auto");
		expect(describeStoredChoice("cpu", GPU).label).toMatch(/CPU/);
	});
});

describe("encoderMatchesVendor", () => {
	it("accepts the vendor's own encoder", () => {
		expect(encoderMatchesVendor("h264_nvenc", 0x10de)).toBe(true);
		expect(encoderMatchesVendor("h264_amf", 0x1002)).toBe(true);
		expect(encoderMatchesVendor("h264_qsv", 0x8086)).toBe(true);
	});

	it("flags an encoder from the wrong vendor — the failure this feature exists to prevent", () => {
		expect(encoderMatchesVendor("h264_amf", 0x10de)).toBe(false);
		expect(encoderMatchesVendor("h264_nvenc", 0x1002)).toBe(false);
	});

	it("does not judge a software encoder", () => {
		expect(encoderMatchesVendor("libopenh264", 0x10de)).toBe(true);
		expect(encoderMatchesVendor(undefined, 0x10de)).toBe(true);
	});
});
