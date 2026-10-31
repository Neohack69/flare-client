# Mirror manifest

This repository is a **generated allowlist snapshot** of the private Flare
source monorepo. Do not open pull requests with new files here: changes are
produced by the sync script and reviewed in the source repository.

- source: `e5edcaa`
- source-commit: `e5edcaaf996753d579128481deccfdf48ac8c834`
- generated: `2026-10-31T07:09:34.341Z`
- generator: `scripts/sync-client-mirror.mjs`
- license: Apache-2.0 (see `LICENSE`)

## Mirrored paths

```
apps/desktop
packages/agent
packages/contracts
packages/scoring
packages/i18n
packages/config
scripts/check-licenses.mjs
tsconfig.base.json
pnpm-workspace.yaml
eslint.config.mjs
prettier.config.mjs
```

## Generated files

```
package.json
pnpm-lock.yaml
MIRROR.md
LICENSE
NOTICE
SECURITY.md
README.md
PRIVACY.md
docs/code-signing-policy.md
.github/workflows/release.yml
.gitignore
.gitattributes
```

## Not included

`apps/api`, `apps/web`, `apps/admin`, `packages/ui`, `packages/drills`,
`packages/prompts`, `apps/msfs-plugin`, the server deployment and
infrastructure directories, `docs` (except `docs/code-signing-policy.md`),
internal QA/automation harnesses (`qa-*`, replay harnesses), server
configuration, secrets, `.env` files.

Files in snapshot: **365** source + **9** generated.
