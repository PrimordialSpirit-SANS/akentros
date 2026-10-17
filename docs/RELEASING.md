# Release runbook

This is the operational checklist for cutting an Akentros release. The
mechanical parts (verification, npm publish, GHCR images, GitHub Release)
are automated by `.github/workflows/release.yml` and triggered by pushing an
annotated `v*` tag; this document covers what the workflow cannot do by
itself: the one-time platform settings, the secrets it consumes, and the
post-release verification.

## 0. One-time platform settings (GitHub web UI)

These cannot be committed as files; do them once per repository.

| Setting | Where | Value |
| --- | --- | --- |
| **Repo topics** (ECO-COMM-4) | Repo → Settings → General → Topics | `ai-gateway`, `openai-compatible`, `llm`, `llm-gateway`, `api-gateway`, `self-hosted`, `hono`, `typescript`, `cloudflare-workers`, `sqlite` |
| **Discussions** (ECO-COMM-5) | Repo → Settings → General → Features | Enable Discussions; create the categories `Q&A` (answered flag on), `Ideas`, `Show and tell`, `General`. `CONTRIBUTING.md` already promises this channel. |
| **Community standards check** | Repo → Insights → Community standards | After the above plus `CODE_OF_CONDUCT.md` / `SUPPORT.md` / PR template land, every row should read green. |
| **`NPM_TOKEN` secret** | Repo → Settings → Secrets and variables → Actions | An npm **Automation** access token with publish rights to the `@akentros` scope (npm → Access Tokens; Automation bypasses 2FA-at-publish prompts in CI). |

The topics list is chosen for GitHub's topic search and the Explore feed:
`ai-gateway` and `openai-compatible` are the two highest-traffic discovery
terms for this project category; the stack terms (`hono`, `typescript`,
`cloudflare-workers`, `sqlite`) catch framework-specific browsing.

## 1. Pre-flight (every release)

1. **Version alignment.** Bump `version` in all four manifests to the same
   value: root `package.json`, `packages/core/package.json`,
   `apps/gateway/package.json`, `apps/console/package.json`. The release
   workflow hard-fails if any of them diverges from the tag
   (`guard-version-alignment` job), so misalignment is caught before anything
   is published.
2. **CHANGELOG cut.** Move the finished entries from `[Unreleased]` into a
   new `## [X.Y.Z] - YYYY-MM-DD` section, keep a fresh empty `[Unreleased]`,
   and add the compare links at the bottom of the file (Keep a Changelog
   format). Register audit IDs (`ECO-*`, `SEC-*`, `FUNC-*`, `N*`) in the
   entries — they are the project's tracking convention.
3. **CI green on main.** The tag pipeline re-runs the full gauntlet anyway;
   a red main means a wasted tag.

## 2. Cut the release

```bash
git tag -a vX.Y.Z -m "Akentros Gateway vX.Y.Z"
git push origin main vX.Y.Z      # branch first if release-cut happens off main
```

The workflow then, in order:

1. `verify` — lint, typecheck, tests, production build (the same gauntlet as
   CI).
2. `guard-version-alignment` — every workspace version equals the tag.
3. `publish-npm` — `npm run stage --workspace @akentros/core` assembles the
   artifact (dist build via the amaro type-stripper + a derived
   `exports`→dist manifest; see `packages/core/scripts/stage-publish.mjs`),
   then publishes `packages/core/.publish-stage` with `NPM_TOKEN`. The
   in-repo manifest stays `private: true`, so publishing anything but the
   staged directory is impossible by construction.
4. `publish-ghcr` — builds and pushes `gateway` and `console` image targets
   to `ghcr.io/<owner>/gateway:<tag>` and `ghcr.io/<owner>/console:<tag>`
   (plus `latest`; owner lowercased, as GHCR requires).
5. `github-release` — opens the GitHub Release with auto-generated notes
   from the merged PRs since the previous tag.

## 3. Post-release verification

- GitHub Releases page shows the tag with notes; the workflow run is green.
- `npm view @akentros/core@X.Y.Z version` returns the version (the workflow
  probes this itself and warns if the registry is slow to surface it).
- `docker pull ghcr.io/<owner>/gateway:X.Y.Z` succeeds and
  `docker run --rm ghcr.io/<owner>/gateway:X.Y.Z node -e
  "console.log('image ok')"` executes (the real entrypoint needs secrets —
  see Topology D in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full
  smoke test).
- The new version's CHANGELOG section is visible on the Release page.

## 4. Ecosystem metrics review (2–4 weeks after each release)

Per the ecosystem audit's tracking recommendation, check whether the release
actually moved the needle:

- GitHub: stars, external forks, external issues/PRs (exclude the known
  internal accounts), Discussions activity.
- npm: weekly downloads of `@akentros/core`
  (`https://api.npmjs.org/downloads/point/last-week/@akentros/core`).
- Search: external web mentions of "akentros gateway".

Record the numbers in the tracking issue for the `ECO-*` series so trends
are comparable across releases.
