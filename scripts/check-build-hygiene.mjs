#!/usr/bin/env node
// Build hygiene for the packaged renderer.
//
// `vite build --emptyOutDir false` exists because the safe-delete guard refuses to let the build
// wipe `dist/cursors`, and that flag has a cost the V2.7.2 rounds paid twice: old chunks stay in
// `dist/assets` and get swept into the asar, including one that still carried a debug probe. The
// checks below are the ones that would have caught it, in the order they cost the least to run.
//
//   node scripts/check-build-hygiene.mjs [--dist dist] [--asar path/to/app.asar]
//
// Exits 1 on a real problem, prints what it looked at either way. Read-only.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const root = process.cwd();
const dist = path.resolve(root, arg("dist", "dist"));
const asar = arg("asar", null);

/**
 * Strings that must never ship: debug hooks left in during an acceptance round.
 *
 * Deliberately NOT the shim's own keys (`browser-shim-cursor-v1` and friends): the browser shim is
 * part of the shipped renderer — it is what lets the editor run in a plain tab — so its storage
 * keys belong in the bundle.
 */
const FORBIDDEN = ["__cursorProbe"];

const problems = [];
const notes = [];

function fail(message) {
	problems.push(message);
}

if (!existsSync(dist)) {
	fail(`no build output at ${dist} — run the renderer build first`);
} else {
	const indexPath = path.join(dist, "index.html");
	if (!existsSync(indexPath)) {
		fail("dist/index.html is missing");
	} else {
		const html = readFileSync(indexPath, "utf8");
		// Every asset the document names must exist. A stale index.html pointing at a deleted
		// chunk is the failure mode that looks fine until the window goes blank.
		const referenced = [...html.matchAll(/(?:src|href)="\.?\/?((?:assets|electron)\/[^"?]+)/g)].map(
			(m) => m[1],
		);
		for (const rel of referenced) {
			if (!existsSync(path.join(dist, rel))) fail(`index.html references a missing file: ${rel}`);
		}
		notes.push(
			`index.html references ${referenced.length} asset(s), all present: ${referenced.length > 0 && referenced.every((r) => existsSync(path.join(dist, r)))}`,
		);

		// The entry chunks, and what they import, must exist too: a dynamic import to a chunk that
		// was deleted is only discovered at click time.
		const entries = referenced.filter((r) => r.endsWith(".js"));
		let missingImports = 0;
		for (const entry of entries) {
			const body = readFileSync(path.join(dist, entry), "utf8");
			for (const m of body.matchAll(/["'`]\.\/([A-Za-z0-9_.-]+\.js)["'`]/g)) {
				if (!existsSync(path.join(dist, "assets", m[1]))) {
					missingImports += 1;
					fail(`${entry} imports a missing chunk: assets/${m[1]}`);
				}
			}
		}
		notes.push(`entry chunks checked: ${entries.length}, missing imports: ${missingImports}`);
	}

	const assetsDir = path.join(dist, "assets");
	if (existsSync(assetsDir)) {
		const files = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
		const withForbidden = [];
		for (const file of files) {
			const body = readFileSync(path.join(assetsDir, file), "utf8");
			for (const needle of FORBIDDEN) {
				if (body.includes(needle)) withForbidden.push(`${file} (${needle})`);
			}
		}
		for (const hit of withForbidden) fail(`shipped chunk carries a test hook: ${hit}`);

		// Chunks nothing points at: not fatal (a lazily-imported chunk can be reachable from a chunk
		// we did not parse), but they are what fills the asar with history, so say how many there are.
		const allJs = new Set(files);
		const referencedJs = new Set();
		const html = existsSync(path.join(dist, "index.html"))
			? readFileSync(path.join(dist, "index.html"), "utf8")
			: "";
		for (const m of html.matchAll(/assets\/([A-Za-z0-9_.-]+\.js)/g)) referencedJs.add(m[1]);
		for (const file of files) {
			const body = readFileSync(path.join(assetsDir, file), "utf8");
			for (const m of body.matchAll(/["'`]\.\/([A-Za-z0-9_.-]+\.js)["'`]/g)) referencedJs.add(m[1]);
		}
		const orphans = [...allJs].filter((f) => !referencedJs.has(f));
		notes.push(
			`chunks on disk: ${allJs.size}, not reachable from the entry graph: ${orphans.length}`,
		);
		if (orphans.length > 0) notes.push(`  e.g. ${orphans.slice(0, 5).join(", ")}`);
	}
}

if (asar) {
	const asarPath = path.resolve(root, asar);
	if (!existsSync(asarPath)) {
		fail(`--asar points at nothing: ${asarPath}`);
	} else {
		const size = statSync(asarPath).size;
		const blob = readFileSync(asarPath);
		for (const needle of FORBIDDEN) {
			if (blob.includes(needle)) fail(`app.asar contains ${needle}`);
		}
		notes.push(
			`app.asar ${(size / 1e6).toFixed(1)} MB, no forbidden strings: ${!FORBIDDEN.some((n) => blob.includes(n))}`,
		);
	}
}

for (const note of notes) console.log(`ok   ${note}`);
for (const problem of problems) console.log(`FAIL ${problem}`);
console.log(
	problems.length === 0 ? "\nbuild hygiene: OK" : `\nbuild hygiene: ${problems.length} problem(s)`,
);
process.exit(problems.length === 0 ? 0 : 1);
