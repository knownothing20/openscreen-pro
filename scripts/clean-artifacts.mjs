#!/usr/bin/env node
// Build-artifact cleanup, bounded by docs/storage-conventions.md.
//
// Default is a dry run: it prints what it would delete and exits 0. `--apply` is required to
// remove anything, and even then this script only ever touches two things — `release/` directories
// beyond the newest two generations, and `dist*` when asked explicitly.
//
// It does NOT touch the recordings directory. That is the one irreversible thing on the machine
// (a project stores paths into it, so deleting a take breaks the projects that reference it), and
// no automated path should be able to remove it.
//
//   node scripts/clean-artifacts.mjs                 # list
//   node scripts/clean-artifacts.mjs --apply         # delete old release/ generations
//   node scripts/clean-artifacts.mjs --apply --dist  # also remove dist/ and dist-electron/

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const includeDist = argv.includes("--dist");
const KEEP_GENERATIONS = 2;

const root = process.cwd();
const releaseDir = path.join(root, "release");

function dirSize(dir) {
	let total = 0;
	const walk = (p) => {
		for (const entry of readdirSync(p, { withFileTypes: true })) {
			const full = path.join(p, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) {
				try {
					total += statSync(full).size;
				} catch {
					// Vanished between readdir and stat (a build still writing). It costs a few bytes
					// of accuracy in a number whose only job is to be informative.
				}
			}
		}
	};
	try {
		walk(dir);
	} catch {
		// Unreadable directory: report it as zero rather than failing the whole listing.
	}
	return total;
}

const human = (n) => {
	if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
	if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
	return `${Math.round(n / 1024)} KB`;
};

if (!existsSync(releaseDir)) {
	console.log("no release/ directory — nothing to clean");
	process.exit(0);
}

// Generations are ordered by mtime, not by name: names follow whatever version scheme the round
// used, and lexical order would happily sort `v272-final` above `v28-unpacked`.
const generations = readdirSync(releaseDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => {
		const full = path.join(releaseDir, entry.name);
		return { name: entry.name, path: full, mtime: statSync(full).mtimeMs, size: dirSize(full) };
	})
	.sort((a, b) => b.mtime - a.mtime);

const keep = generations.slice(0, KEEP_GENERATIONS);
const drop = generations.slice(KEEP_GENERATIONS);

console.log(
	`release/: ${generations.length} generation(s), ${human(generations.reduce((s, g) => s + g.size, 0))}`,
);
console.log(`\nkeeping the newest ${KEEP_GENERATIONS}:`);
for (const g of keep) console.log(`  keep  ${human(g.size).padStart(8)}  ${g.name}`);

if (drop.length === 0) {
	console.log("\nnothing to remove");
} else {
	console.log(`\nto remove (${drop.length}):`);
	for (const g of drop) console.log(`  drop  ${human(g.size).padStart(8)}  ${g.name}`);
	console.log(`\nreclaimable: ${human(drop.reduce((s, g) => s + g.size, 0))}`);
}

const distDirs = ["dist", "dist-electron"].filter((d) => existsSync(path.join(root, d)));
if (includeDist && distDirs.length > 0) {
	console.log("\ndist outputs (rebuildable):");
	for (const d of distDirs)
		console.log(`  drop  ${human(dirSize(path.join(root, d))).padStart(8)}  ${d}/`);
}

if (!apply) {
	console.log("\ndry run — pass --apply to delete. Recordings are never touched.");
	process.exit(0);
}

// Deleting needs a human in the loop when it is not a dry run and nobody passed --apply.
let removed = 0;
for (const g of drop) {
	rmSync(g.path, { recursive: true, force: true });
	removed += g.size;
	console.log(`removed ${g.name}`);
}
if (includeDist) {
	for (const d of distDirs) {
		rmSync(path.join(root, d), { recursive: true, force: true });
		console.log(`removed ${d}/`);
	}
}
console.log(`\nreclaimed ${human(removed)}`);
