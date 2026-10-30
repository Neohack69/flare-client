# Flare Client

Source mirror of the **Flare** desktop client - a thin, read-only flight
recorder for **MSFS 2024** and **X-Plane 12**. It records telemetry locally,
computes a deterministic landing score and syncs flight aggregates to the
pilot's Flare account. Scoring and analytics are server-authoritative; this
repository contains only the client, the read-only agent and the shared
contracts/packages needed to build them.

This repository is generated from the project's source repository by an
allowlist snapshot. It contains **no** server, web, admin, deployment or
infrastructure code. See [`MIRROR.md`](MIRROR.md) for the exact source commit
and the list of mirrored paths.

## Components

| Path | What it is |
|---|---|
| `apps/desktop` | Electron client (tray, status window, updater, agent host) |
| `packages/agent` | Read-only recorder: SimConnect (MSFS 2024) / X-Plane 12 Web API |
| `packages/contracts` | Zod schemas and shared TypeScript contracts |
| `packages/scoring` | Deterministic landing scoring (no I/O, no clock, no randomness) |
| `packages/i18n` | Client strings (RU + EN) |
| `packages/config` | Shared ESLint/Prettier/TS presets |

## Building

Requirements: Node.js >= 22.14, pnpm 9.x, Windows for packaging.

```powershell
pnpm install --frozen-lockfile
pnpm --filter @flightlog/desktop build:deps
pnpm --filter @flightlog/desktop build
pnpm --filter @flightlog/desktop package:win   # unsigned NSIS installer
```

The unsigned installer is written to `apps/desktop/release/`. Releases
published from this repository are signed by SignPath Foundation (see below).

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

- Authors and committers: [@Neohack69](https://github.com/Neohack69)
- Reviewers: [@Neohack69](https://github.com/Neohack69)
- Approvers: [@Neohack69](https://github.com/Neohack69) (repository owner)

Every signing request is approved manually by the owner. All build jobs run on
GitHub-hosted runners (`windows-latest`); self-hosted runners are not used for
signed builds. MFA is required for every account with write access.

The signed artifact is the NSIS installer `Flare-Setup-<version>.exe`. The
full policy, roles, artifact configuration and verification steps are in
[`docs/code-signing-policy.md`](docs/code-signing-policy.md).

## Privacy

The client is read-only: it never changes simulator variables, never pauses the
simulator and never interferes with an active flight. What the client sends and
what it does not is described in [`PRIVACY.md`](PRIVACY.md).

## Security

Please report vulnerabilities privately - see [`SECURITY.md`](SECURITY.md).

## License

Apache License 2.0 - see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
Third-party attributions: [`apps/desktop/resources/THIRD_PARTY_NOTICES.txt`](apps/desktop/resources/THIRD_PARTY_NOTICES.txt).

Microsoft Flight Simulator, SimConnect and related marks are trademarks of
Microsoft Corporation. This project is not affiliated with Microsoft.
