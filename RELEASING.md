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
   pnpm -s release-notes x.y.z > /tmp/notes.md   # then paste, or: gh release create vx.y.z --notes-file /tmp/notes.md
   ```

8. **Deploy that tag** and run the [post-deploy check](#after-a-deploy).

Semantic versioning: `2.x` is the v2 plan's releases (plan.md §25.3); a `2.0.0` is the first release that ships
the whole of §25.8's 2.0 checklist. Anything before that on `version/v2` is unreleased work.

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
