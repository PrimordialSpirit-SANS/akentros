#!/usr/bin/env node

// ECO-SUPPLY-1 — assemble the publishable @akentros/core artifact.
//
// The in-repo manifest deliberately points `exports` at `./src/*.ts`:
// development, tests, typecheck and the Docker image all run the TypeScript
// sources directly on Node >= 22.18 (type stripping). The npm artifact must
// instead point at the compiled `./dist/*.js` — and npm 11 no longer applies
// `publishConfig` overrides for `exports` (deprecated with a warning), so the
// release pipeline stages a rewritten manifest instead of relying on that
// mechanism.
//
// This script:
//   1. rebuilds dist (scripts/build-dist.mjs — never stages stale output);
//   2. derives the dist exports map FROM the src exports map (no duplicated
//      table that could drift: every `./src/x.ts` becomes
//      `{ types: ./dist/x.d.ts, default: ./dist/x.js }`);
//   3. copies dist/, config/, README.md and LICENSE into `.publish-stage/`
//      and writes a transformed package.json there:
//        - exports       -> derived dist map
//        - private       -> removed (the staged package is publishable)
//        - scripts       -> removed (an artifact never runs lifecycle code)
//        - devDependencies -> removed (amaro/typescript are build-time only)
//        - publishConfig.access -> "public" (scoped packages default private)
//   4. verifies the staged artifact: every exports target exists inside the
//      stage, and every staged module smoke-imports from the stage directory.
//
// Publish with:      npm publish .publish-stage
// Inspect without publishing:  npm pack --dry-run .publish-stage
// The in-repo package stays `private: true`, so an accidental
// `npm publish` in packages/core is refused by npm itself.

import { spawnSync } from "node:child_process";
import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stageDir = join(pkgRoot, ".publish-stage");

// 1. fresh dist — staging stale output is a silent supply-chain hazard
const build = spawnSync(process.execPath, [join(pkgRoot, "scripts", "build-dist.mjs")], {
  cwd: pkgRoot,
  stdio: "inherit",
});
if (build.error || build.status !== 0) {
  console.error("stage-publish: dist build failed; refusing to stage");
  process.exit(1);
}

// 2. derive the dist exports map from the src exports map
const manifest = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8"));
const distExports = {};
for (const [subpath, target] of Object.entries(manifest.exports)) {
  if (subpath === "./package.json") {
    distExports[subpath] = target;
    continue;
  }
  if (typeof target !== "string" || !target.startsWith("./src/") || !target.endsWith(".ts")) {
    console.error(`stage-publish: unexpected exports entry ${subpath} -> ${target}`);
    process.exit(1);
  }
  const base = target.slice("./src/".length, -".ts".length);
  distExports[subpath] = {
    types: `./dist/${base}.d.ts`,
    default: `./dist/${base}.js`,
  };
}

// 3. stage the artifact
await rm(stageDir, { recursive: true, force: true });
for (const entry of ["dist", "config", "README.md", "LICENSE"]) {
  await cp(join(pkgRoot, entry), join(stageDir, entry), { recursive: true });
}
const staged = { ...manifest };
delete staged.private;
delete staged.scripts;
delete staged.devDependencies;
staged.publishConfig = { ...(staged.publishConfig ?? {}), access: "public" };
staged.exports = distExports;
await writeFile(join(stageDir, "package.json"), `${JSON.stringify(staged, null, 2)}\n`);

// 4. verify the staged artifact
const stagedManifest = JSON.parse(await readFile(join(stageDir, "package.json"), "utf8"));
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}
let verifiedTargets = 0;
for (const target of Object.values(stagedManifest.exports)) {
  const paths = typeof target === "string" ? [target] : Object.values(target);
  for (const relativePath of paths) {
    await readFile(join(stageDir, relativePath)); // throws if missing
    verifiedTargets += 1;
  }
}
let imported = 0;
for (const file of await walk(join(stageDir, "dist"))) {
  if (!file.endsWith(".js")) continue;
  await import(file);
  imported += 1;
}

console.log(
  `stage-publish: ${Object.keys(stagedManifest.exports).length} exports entries, ` +
    `${verifiedTargets} targets verified on disk, ` +
    `${imported} modules smoke-imported from the stage`,
);
console.log(`stage-publish: artifact ready at packages/core/.publish-stage`);
console.log(`stage-publish: publish with  npm publish .publish-stage`);
