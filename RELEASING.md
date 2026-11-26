# Releasing QueryLens

plan.md §25.4 A4. Two rules, both learned the hard way on the first deploy (CHANGELOG 1.0.0, *Fixed*):

1. **A release is cut in one commit, and the tag goes on that commit.** For 1.0.0 the tag was placed on the
   deployed commit and the version bump landed *after* it, so `v1.0.0` still says `0.0.0` in `package.json`. A
   published tag is not moved; do it in the right order instead.
2. **Config that only the platform can judge is looked at on a preview deploy** before anything relies on it —
   see [Deploy config](#deploy-config).

## Cutting a release

1. **Gate green** on the commit you intend to ship: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`,
   `pnpm budget`, `pnpm test:e2e`.
2. **Preview the notes.** `pnpm release-notes` prints `[Unreleased]` as the GitHub release body. The CHANGELOG
   is the only place notes are written — a release's body is derived from it, never retyped. If the output
   reads badly, fix the CHANGELOG, not the release page.
3. **Cut the CHANGELOG.** Rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD`, add a fresh empty
   `## [Unreleased]` above it, and update the link references at the bottom (`[Unreleased]` compares
   `vx.y.z...HEAD`; add `[x.y.z]`).
4. **Bump `package.json`'s `version`** to `x.y.z` — same commit.
5. **Commit** as `chore(release): cut x.y.z`, push, and let CI pass on *that* commit.
6. **Tag that commit**: `git tag -a vx.y.z -m "x.y.z" && git push origin vx.y.z`.
7. **Publish the release** with the derived notes:

   ```bash
   node --experimental-strip-types scripts/release-notes.ts x.y.z > /tmp/notes.md   # then paste, or: gh release create vx.y.z --notes-file /tmp/notes.md
   ```

   The script directly, not `pnpm -s release-notes`: pnpm 11 checks the install before a script runs and prints
   *Already up to date* / *Done in …* on stdout even with `-s`, which would open the release body. A version with a
   pre-release part (`2.0.0-rc.1`) is published as a GitHub *pre-release*.

8. **Deploy that tag** and run the [post-deploy check](#after-a-deploy).

Semantic versioning: `2.x` is the v2 plan's releases (plan.md §25.3); a `2.0.0` is the first release that ships
the whole of §25.8's 2.0 checklist. Anything before that on `version/v2` is unreleased work. `3.x` is the v3 plan's
(plan.md §27): `3.0.0` ships every buildable §27 item at once — its five releases, 3.0–3.4, were built before
any was cut, so they share one version.

## Releasing the packages

Three packages publish from this repository, each with its own version and its own tag:

| Tag | Package | Directory |
| --- | --- | --- |
| `engine-v<version>` | `@querylens/engine` | `packages/engine` |
| `cli-v<version>` | `querylens` (the terminal trace) | `packages/cli` |
| `mcp-v<version>` | `@querylens/mcp` (the MCP server) | `packages/mcp` |

1. Bump `version` in the package's `package.json`, and add the change to `CHANGELOG.md`.
2. Commit, then tag that commit with the tag above and push the tag.
3. `.github/workflows/publish-packages.yml` checks the tag against the package version, runs the gate, builds with
   `pnpm build:packages`, checks that the built package runs, and publishes with `npm publish --provenance`. No npm
   token is involved: the publish is authorised by the workflow's OIDC identity.

Nothing publishes until two things exist outside this repository: the npm organisation `querylens` (for the two
`@querylens/` packages), and a trusted publisher configured for this repository and `publish-packages.yml`. Until
both are in place the tag run fails at the publish step, and nothing is published.

## Deploy config

These files change what the *platform* does rather than what the app does, and no local check exercises the
platform's interpretation of them:

| Path | Why it needs a real deploy |
|---|---|
| `wrangler.jsonc` | Asset routing and the SPA fallback are read by Cloudflare's engine |
| `public/` (`_headers`, `_redirects`, `404.html`, `robots.txt`, fonts) | Served exactly as the platform parses them |
| `index.html` | `canonical`, `og:url` and `og:image` only resolve against the real origin |
| `pnpm-workspace.yaml` | The install-script allowlist is read by the build host's package manager |
| `.node-version` | The build host picks its Node from it |

CI notices a change to any of them (a warning annotation and a step summary on the PR — it never blocks) and
the PR template has a checkbox for it. **Before merging such a change, look at a preview deploy**:

- Build the branch on Cloudflare as a non-production branch build and open its preview URL. (If the project
  does not build non-production branches, turn that on once in the dashboard — it is the whole point of this
  rule.) `pnpm preview` is *not* a substitute: it is Vite's server, not the platform's.
- Then run the [post-deploy check](#after-a-deploy) against the preview URL.

The three failures this rule exists for: an install-script allowlist written as a list where the package manager
wanted a mapping; an SPA rewrite in `_redirects` that formed a redirect cycle on the newer engine; and a
canonical URL pointing at a domain that never resolved.

## After a deploy

Against the live (or preview) origin:

- [ ] A deep link loads the app, not a 404 — `/playground?q=SELECT%20*%20FROM%20users&s=3`, then `/docs/faq`.
- [ ] `/no-such-page` shows the app's 404, and a hashed asset URL returns the asset, not `index.html`.
- [ ] Response headers are intact: CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`
      (`curl -sI <origin>/`); [securityheaders.com](https://securityheaders.com) is still an A+.
- [ ] `<link rel="canonical">`, `og:url` and `og:image` in the served HTML resolve (`curl -s <origin>/ | grep -E 'canonical|og:'`,
      then `curl -sI` each URL).
- [ ] `/robots.txt` and `/favicon.svg` respond; the fonts load (no CSP violations in the console).
- [ ] The build stamp in the served HTML (`meta[name="querylens:build"]`) matches the commit you meant to ship.

## After launch: field performance

There is no telemetry (plan.md §14.4), so real-user performance comes from two places, neither of which the site
sends anything for:

- **CrUX** — Chrome's public field data — once the origin has enough traffic to appear: PageSpeed Insights or
  the CrUX API for the origin. INP, LCP and CLS on real visitors' devices, at no cost to anyone's privacy.
- **The study's opt-in INP** (`pnpm study report` prints it): a participant's own device, volunteered in the
  result code. Small n, but it is the only number from a *lecture-hall* laptop or a phone in a lap.
