# Mirror manifest

This repository is a **generated allowlist snapshot** of the private Flare
source monorepo. Do not open pull requests with new files here: changes are
produced by the sync script and reviewed in the source repository.

- source: `3b75285`
- source-commit: `3b7528588b142634345576d6b3d4fe6350b10161`
- generated: `2026-10-30T21:29:11.014Z`
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

Files in snapshot: **362** source + **9** generated.
