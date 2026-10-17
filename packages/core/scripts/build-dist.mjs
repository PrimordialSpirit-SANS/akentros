#!/usr/bin/env node

// ECO-SUPPLY-1 — dist build for npm publishing (@akentros/core).
//
// The repo runs TypeScript directly on Node >= 22.18 (type stripping), so
// core sources import siblings with explicit `.ts` specifiers — a style tsc
// by design refuses to emit as JavaScript (allowImportingTsExtensions requires
// noEmit). Rather than adding a bundler, this build applies the exact same
// transform Node applies at runtime, via `amaro` (the Node team's standalone
// type-stripping package, a dev-only dependency):
//
//   1. strip types src/**/*.ts -> dist/**/*.js with amaro (`strip-only`
//      mode — the same erasable-syntax transform the gateway already runs
//      under), after rewriting every *relative* `.ts` import specifier to
//      `.js` (bare/package specifiers are untouched);
//   2. emit declarations with `tsc -p tsconfig.build.json`
//      (--emitDeclarationOnly is the one emit mode allowed alongside
//      allowImportingTsExtensions);
//   3. rewrite `.ts` specifiers that bundler-resolution leaves inside the
//      emitted .d.ts files (same rewrite, applied to declaration output);
//   4. smoke-import every published entry point from dist — a broken
//      strip or specifier rewrite fails the build loudly instead of
//      shipping.
//
// Why this is sound: the repo's `verbatimModuleSyntax` + runs-on-Node
// discipline means every non-`import type` import in the sources is a real
// runtime import (Node's type stripper would fail otherwise), and the dist
// transform is byte-for-byte the same erasable-syntax stripping the sources
// already execute under in development — no downleveling, no behavior drift.
//
// Runtime JSON imports (`../config/*.json` with import attributes) keep
// their specifier: `dist/*.js` resolves `../config/*.json` against the
// package root, and `config/` ships in the published tarball (see the
// `files` field in package.json).
//
// Note: this runs via `prepack` (pack/publish time only), NOT `prepare`.
// `prepare` would also fire on `npm ci --omit=dev` inside the slim Docker
// runtime stage, where tsc (a devDependency) is absent and the build would
// fail. In-repo dev/test flows import `src/` directly and never need dist.

import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(pkgRoot, "src");
const distDir = join(pkgRoot, "dist");

// `from "./x.ts"` (static, incl. type-only and export-from), `import "./x.ts"`
// (side-effect) and `import("./x.ts")` (dynamic). Only *relative* specifiers
// start with a dot; the backreference keeps quote styles paired and anchors
// the `.ts` at the end of the specifier.
const specifierRe = /(from\s*|import\s*\(?\s*)(["'])(\.\.?\/[^"']+?)\.ts\2/g;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

function rewrite(text, counter) {
  return text.replace(specifierRe, (_match, keyword, quote, specifier) => {
    counter.count += 1;
    return `${keyword}${quote}${specifier}.js${quote}`;
  });
}

await rm(distDir, { recursive: true, force: true });

// Load the type stripper and resolve the compiler through Node's own module
// resolution (hoisting may place them in the repo root's node_modules) — no
// PATH assumptions. amaro's `strip-only` is the erasable-syntax transform
// Node itself applies when running these .ts sources directly.
const require = createRequire(import.meta.url);
const { transformSync } = require("amaro");
const tsManifestPath = require.resolve("typescript/package.json");
const tsManifest = JSON.parse(await readFile(tsManifestPath, "utf8"));
const tsBinField = tsManifest.bin ?? {};
const tsBinRel = typeof tsBinField === "string" ? tsBinField : tsBinField.tsc;
const tscBin = join(dirname(tsManifestPath), tsBinRel);

// 1. sources -> dist as .js: relative specifier rewrite + type stripping
const jsRewrites = { count: 0 };
let sourceFiles = 0;
for (const file of await walk(srcDir)) {
  const relativePath = relative(srcDir, file);
  if (!relativePath.endsWith(".ts")) continue;
  const outPath = join(distDir, relativePath.replace(/\.ts$/, ".js"));
  const source = await readFile(file, "utf8");
  const { code } = transformSync(rewrite(source, jsRewrites), { mode: "strip-only" });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, code);
  sourceFiles += 1;
}

// 2. declarations via tsc (emitDeclarationOnly; see tsconfig.build.json)
const tsc = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.build.json"], {
  cwd: pkgRoot,
  stdio: "inherit",
});
if (tsc.error) {
  console.error(`tsc failed to start: ${tsc.error.message}`);
  process.exit(1);
}
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

// 3. declaration specifier hygiene (bundler resolution leaves `.ts` intact)
const dtsRewrites = { count: 0 };
for (const file of await walk(distDir)) {
  if (!file.endsWith(".d.ts")) continue;
  const text = await readFile(file, "utf8");
  const next = rewrite(text, dtsRewrites);
  if (next !== text) await writeFile(file, next);
}

// 4. smoke-import every built module from dist — a broken strip or specifier
//    rewrite fails the build loudly instead of shipping.
for (const file of await walk(distDir)) {
  if (!file.endsWith(".js")) continue;
  await import(file);
}
console.log(
  `core dist build: ${sourceFiles} modules, ` +
    `${jsRewrites.count} JS specifier rewrites, ` +
    `${dtsRewrites.count} .d.ts specifier rewrites, ` +
    `all ${sourceFiles} modules smoke-imported from dist`,
);
