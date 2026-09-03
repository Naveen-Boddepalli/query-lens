# Security Policy

## Scope

QueryLens is a **client-side-only** educational tool. It has:

- No server or backend
- No authentication or user accounts
- No database connections
- No user data collection or storage
- No cookies or telemetry
- No secrets or API keys

All processing happens in-memory in the browser. Nothing leaves the user's machine.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| Latest `main` | ✅ |
| Older commits | ❌ |

This project is pre-1.0 and does not maintain multiple release branches.

## Reporting a Vulnerability

If you find a security issue — for example, an XSS vulnerability in the URL state parser, or a dependency with a known CVE — please report it responsibly:

1. **Preferred:** Use [GitHub Security Advisories](https://github.com/Naveen-Boddepalli/QueryLens/security/advisories/new) to report privately.
2. **Alternative:** Email `naveen.boddepalli@outlook.com` with details.

Please **do not** open a public GitHub issue for security vulnerabilities.

### What to expect

- **Acknowledgment** within 48 hours
- **Status update** within 7 days
- **Fix or mitigation** as soon as practical, typically within 14 days for dependency issues

## Dependency Security

The project uses several proactive measures:

- **`minimumReleaseAge: 10080`** — pnpm will not resolve packages published less than 7 days ago
- **`blockExoticSubdeps: true`** — blocks exotic protocols in sub-dependencies  
- **`allowBuilds: []`** — no package in the dependency graph may run install scripts
- **GitHub Actions pinned to full SHA** — prevents tag-hijacking supply chain attacks
- **Dependabot** — weekly dependency update PRs, grouped by risk
- **`pnpm audit --prod`** — run regularly to check for known vulnerabilities
