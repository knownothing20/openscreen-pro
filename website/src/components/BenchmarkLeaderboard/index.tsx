/**
 * The live standings from the export benchmark, read from the published site's
 * own aggregate.json instead of copied into the post.
 *
 * Client-side on purpose. That file is regenerated every time a submission PR
 * merges in the benchmark repo, while this site rebuilds on website/** and on
 * releases — resolving the numbers at build time would leave the post quoting
 * whatever happened to be true the last time something unrelated changed here.
 *
 * An <iframe> of the results page was the other option and is the wrong one: it
 * is 93 KB of a differently themed document with its own scrollbar, and it
 * carries none of this site's tokens. The JSON is served with
 * Access-Control-Allow-Origin: *, and Last-Modified is CORS-safelisted, so the
 * table and its "as of" date both come from one request.
 */

import { useEffect, useState } from "react";

import styles from "./styles.module.css";

const SITE = "https://etiennelescot.github.io/screen-recorder-benchmark/";
const DATA_URL = `${SITE}aggregate.json`;

const PLATFORM_NAMES: Record<string, string> = {
	darwin: "macOS",
	linux: "Linux",
	win32: "Windows",
};

type Setup = {
	platform: string;
	machine: string;
	gpu?: string;
	runs: number;
	cost: number;
};

type Tool = {
	node: string;
	tool: string;
	build: string;
	prerelease?: boolean;
	relativeCost: number;
	setups?: Setup[];
	submissions: number;
	machines: string[];
	platforms: string[];
	versions?: string[];
	observedCostRange?: [number, number];
};

type BuildPart = {
	build: string;
	prerelease?: boolean;
	platforms: string[];
};

type RankedRow = {
	node: string;
	tool: string;
	build: string;
	prerelease: boolean;
	builds: BuildPart[];
	relativeCost: number;
	setups: Setup[];
	submissions: number;
	machines: string[];
	platforms: string[];
};

type Aggregate = { tools: Tool[]; used: unknown[] };

type State =
	| { status: "loading" }
	| { status: "error" }
	| { status: "ready"; data: Aggregate; asOf: string };

function unique(values: string[][]): string[] {
	return [...new Set(values.flat())];
}

const cmpStr = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * Which of two builds is the newer. Ported from the benchmark's own
 * lib/aggregate.mjs so the two agree.
 */
function compareBuilds(a: string, b: string): number {
	const parse = (v: string) => {
		const [num, tag = ""] = v.split("-");
		return { parts: num.split(".").map((n) => Number(n) || 0), tag };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
		const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
		if (d) return d;
	}
	if (x.tag === y.tag) return 0;
	// No tag is the release itself, and it outranks every candidate for it.
	if (!x.tag) return 1;
	if (!y.tag) return -1;
	return cmpStr(x.tag, y.tag);
}

/**
 * One row per tool, built from the newest build measured on each platform.
 * Ported from the benchmark's lib/aggregate.mjs (newestPerPlatform).
 *
 * Taking the newest build per platform is what a reader on any given platform
 * would actually install: when a vendor ships at different cadences per
 * platform (e.g. FocuSee 2.4.1 on macOS and 2.3.5 on Windows), this averages
 * the current release across platforms instead of taking only the globally
 * newest build which would drop all Windows runs.
 */
function newestPerPlatform(tools: Tool[]): RankedRow[] {
	const byTool = new Map<string, Tool[]>();
	for (const t of tools) {
		if (!byTool.has(t.tool)) byTool.set(t.tool, []);
		byTool.get(t.tool)!.push(t);
	}
	const rows: RankedRow[] = [];
	for (const [tool, builds] of byTool) {
		const newestOn = new Map<string, Tool>();
		for (const b of builds) {
			for (const s of b.setups ?? []) {
				const cur = newestOn.get(s.platform);
				if (!cur || compareBuilds(b.build, cur.build) > 0) newestOn.set(s.platform, b);
			}
		}
		const kept = builds
			.map((b) => ({
				build: b,
				setups: (b.setups ?? []).filter((s) => newestOn.get(s.platform) === b),
			}))
			.filter((x) => x.setups.length)
			.sort(
				(x, y) => compareBuilds(y.build.build, x.build.build) || cmpStr(x.build.node, y.build.node),
			);
		if (!kept.length) continue;
		const setups = kept.flatMap((x) => x.setups);
		const lead = kept[0].build;
		rows.push({
			node: lead.node,
			tool,
			build: lead.build,
			prerelease: kept.some((x) => x.build.prerelease),
			builds: kept.map((x) => ({
				build: x.build.build,
				prerelease: x.build.prerelease,
				platforms: [...new Set(x.setups.map((s) => s.platform))].sort(cmpStr),
			})),
			relativeCost: +(setups.reduce((n, s) => n + s.cost, 0) / setups.length).toFixed(3),
			setups,
			submissions: setups.reduce((n, s) => n + s.runs, 0),
			machines: [...new Set(setups.map((s) => s.machine).filter(Boolean))],
			platforms: [...new Set(setups.map((s) => s.platform).filter(Boolean))],
		});
	}
	return rows.sort((a, b) => a.relativeCost - b.relativeCost || cmpStr(a.node, b.node));
}

export default function BenchmarkLeaderboard() {
	const [state, setState] = useState<State>({ status: "loading" });

	useEffect(() => {
		let live = true;
		(async () => {
			try {
				const res = await fetch(DATA_URL, { signal: AbortSignal.timeout(8000) });
				if (!res.ok) throw new Error(String(res.status));
				const data = (await res.json()) as Aggregate;
				if (!Array.isArray(data?.tools) || data.tools.length === 0) throw new Error("no tools");
				// ISO rather than toLocaleDateString: the visitor's locale would make
				// this render differently for every reader for no gain.
				const modified = res.headers.get("last-modified");
				const asOf = modified ? new Date(modified).toISOString().slice(0, 10) : "";
				if (live) setState({ status: "ready", data, asOf });
			} catch {
				if (live) setState({ status: "error" });
			}
		})();
		return () => {
			live = false;
		};
	}, []);

	if (state.status !== "ready") {
		return (
			<div className={styles.panel}>
				<p className={styles.fallback}>
					{state.status === "loading"
						? "Loading the current standings…"
						: "The standings could not be loaded. "}
					{state.status === "error" && (
						<a href={SITE} target="_blank" rel="noopener noreferrer">
							Read them on the benchmark site
						</a>
					)}
				</p>
			</div>
		);
	}

	const { data, asOf } = state;
	// Coverage is counted over every build measured, not only the rows shown:
	// dropping a superseded build must not shrink the machine list it earned.
	const platforms = unique(data.tools.map((t) => t.platforms));
	const machines = unique(data.tools.map((t) => t.machines));
	const tools = newestPerPlatform(data.tools);
	const max = tools[tools.length - 1].relativeCost;

	return (
		<div className={styles.panel}>
			<div className={styles.head}>
				<span className={styles.kicker}>Cost relative to ffmpeg · lower is better</span>
				<span className={styles.meta}>
					{data.used.length} submissions · {tools.length} tools · {machines.length} machines ·{" "}
					{platforms.map((p) => PLATFORM_NAMES[p] ?? p).join(", ")}
					{asOf && ` · data as of ${asOf}`}
				</span>
			</div>

			<table className={styles.table}>
				<thead>
					<tr>
						<th scope="col">#</th>
						<th scope="col">Tool</th>
						<th scope="col">Cost</th>
					</tr>
				</thead>
				<tbody>
					{tools.map((t, i) => (
						<tr
							key={t.node}
							title={`${t.submissions} submission${t.submissions === 1 ? "" : "s"} · ${t.machines.join(", ")}`}
						>
							<td className={styles.rank}>{String(i + 1).padStart(2, "0")}</td>
							<td className={styles.name}>
								{t.tool}
								<span
									className={styles.build}
									title={
										t.builds.length > 1
											? "This tool is not on the same release everywhere it was measured — each platform contributes the newest build measured on it"
											: undefined
									}
								>
									{t.builds.length > 1
										? t.builds
												.map(
													(b) =>
														`${b.build} (${b.platforms.map((p) => PLATFORM_NAMES[p] ?? p).join(", ")})`,
												)
												.join(" · ")
										: t.build}
								</span>
								{t.prerelease && (
									<span
										className={styles.tag}
										title="A prerelease — published by the vendor, but not the release build"
									>
										rc
									</span>
								)}
							</td>
							<td className={styles.plotCell}>
								<span className={styles.plot}>
									<span className={styles.track} aria-hidden="true">
										<span
											className={styles.bar}
											style={{ width: `${(t.relativeCost / max) * 100}%` }}
										/>
										{/* Where a bare ffmpeg re-encode finishes. Without it the bars
										    read as if every millisecond were compositing. */}
										<span className={styles.floor} style={{ left: `${(1 / max) * 100}%` }} />
									</span>
									<span className={styles.value}>{t.relativeCost.toFixed(2)}×</span>
								</span>
							</td>
						</tr>
					))}
				</tbody>
			</table>

			<p className={styles.note}>
				The notch on each bar is 1×, where a bare ffmpeg re-encode of the same clip finishes on that
				machine. Everything to its right is what the tool spends compositing. Each row is the newest
				build measured for that tool; the builds it replaced still hold the graph together.
			</p>

			<a className={styles.link} href={SITE} target="_blank" rel="noopener noreferrer">
				Every run, every machine, and the spread between them →
			</a>
		</div>
	);
}
