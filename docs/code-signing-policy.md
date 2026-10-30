# Code signing policy — Flare desktop client

- Product: **Flare** (Windows desktop client)
- Artifact: NSIS installer `Flare-Setup-<version>.exe`
- Repository: <https://github.com/Neohack69/flare-client>
- Signing service: [SignPath.io](https://about.signpath.io), certificate by
  [SignPath Foundation](https://signpath.org)
- Last updated: 2026-10-31

This policy covers only the open-source desktop client published from this
repository. The hosted Flare service and other components are out of scope.

## Statement

> **Code signing policy**
> Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
> [SignPath Foundation](https://signpath.org).

The same statement is published on the repository home page (`README.md`) and on
the product download page.

## Roles and people

| Role | Who | Responsibility |
|---|---|---|
| Author / committer | [@Neohack69](https://github.com/Neohack69) | Writes and commits client code |
| Reviewer | [@Neohack69](https://github.com/Neohack69) | Reviews changes from non-committers |
| Approver | [@Neohack69](https://github.com/Neohack69) (repository owner) | Approves **each** signing request manually |

MFA is mandatory for every account with write access to the repository and for
the SignPath account. The approver action is a separate, manual step for every
release (`release-signing` GitHub Environment with required reviewer, plus the
manual approval configured in the SignPath signing policy).

## Build and signing process

1. A release starts from a tag `v<version>` (or a manual `workflow_dispatch`
   with `channel` and `version` inputs) on this repository.
2. The workflow `.github/workflows/release.yml` runs **entirely on
   GitHub-hosted `windows-latest` runners**. Self-hosted runners are never used
   for a signed build.
3. The workflow installs dependencies from the committed `pnpm-lock.yaml`
   (`--frozen-lockfile`), runs the strong-copyleft license gate, lint,
   typecheck, unit tests, the native-module check and the build.
4. The NSIS installer is built **unsigned**
   (`CSC_IDENTITY_AUTO_DISCOVERY=false`); no certificate or private key exists
   in this repository or in its CI.
5. The unsigned installer is uploaded as a GitHub Actions artifact
   (`archive: false`, so the artifact is the raw `.exe`).
6. A signing request is submitted to SignPath with the `nsis-installer`
   artifact configuration. The request waits for manual approval.
7. SignPath returns the signed installer. The workflow verifies the
   Authenticode signature (`Get-AuthenticodeSignature` → `Valid`, signer
   `SignPath Foundation`).
8. Update metadata is regenerated **from the signed bytes** (see below), then a
   GitHub Release is published with the installer, `latest.yml`/`beta.yml` and
   `SHA256SUMS.txt`.

No SSH keys, deployment credentials, server addresses or `.env` files are
present in this repository. The public workflow cannot deploy anything to a
server.

## Update metadata after signing

Signing changes the installer bytes, so the `sha512` and `size` that
`electron-builder` wrote before signing are invalid. After signing the workflow
runs:

```powershell
node apps/desktop/scripts/regen-feed.mjs --channel <latest|beta>
node apps/desktop/scripts/regen-feed.mjs --channel <latest|beta> --verify
```

`regen-feed.mjs` rebuilds `<channel>.yml` from the **signed** installer
(`version`, `files[].url/sha512/size`, `path`, `sha512`, `releaseDate`),
writes `SHA256SUMS.txt`, and verifies that
`base64(SHA-512(installer))` equals the `sha512` field in the feed. A stale
`.blockmap` produced from the unsigned bytes is removed and is not published;
updates use a full download.

## SignPath artifact configuration `nsis-installer`

SignPath enforces the version resource of the installer (`metadata
restrictions`). The installer metadata comes from
`apps/desktop/electron-builder.yml` (`productName: Flare`, `appId:
dev.flightlog.desktop`, `author.name: Flare`, `copyright: Copyright © Flare`).

| Field | Value |
|---|---|
| Artifact configuration slug | `nsis-installer` |
| File | `Flare-Setup-*.exe` |
| Product name | `Flare` |
| Product version | build input `version` (from `apps/desktop/package.json`, no `v` prefix) |
| File version | same as product version |
| Company name | `Flare` |
| Hash algorithm | SHA-256 (Authenticode) |

Only the four fields above are enforced. `OriginalFilename` is empty in the NSIS
installer's version resource, and `LegalCopyright` is `Copyright c Flare`
(electron-builder writes ANSI version resources); these two fields are therefore
deliberately **not** constrained — otherwise SignPath would reject the artifact
on a metadata mismatch.

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <parameters>
    <parameter name="version" required="true" />
  </parameters>
  <pe-file path="Flare-Setup-*.exe"
           product-name="Flare"
           product-version="${version}"
           file-version="${version}"
           company-name="Flare">
    <authenticode-sign hash-algorithm="sha256" />
  </pe-file>
</artifact-configuration>
```

Before submitting, confirm the actual version resource of a locally built
installer:

```powershell
(Get-Item "apps\desktop\release\Flare-Setup-0.3.37.exe").VersionInfo |
  Format-List ProductName, ProductVersion, FileVersion, CompanyName, LegalCopyright, OriginalFilename
```

Expected: `ProductName=Flare`, `ProductVersion=0.3.37`, `FileVersion=0.3.37`,
`CompanyName=Flare`. If a constrained field differs, fix
`apps/desktop/electron-builder.yml` or `apps/desktop/package.json` first —
SignPath rejects a mismatch.

## How a user verifies a download

```powershell
Get-AuthenticodeSignature .\Flare-Setup-<version>.exe | Format-List Status, SignerCertificate
Get-FileHash .\Flare-Setup-<version>.exe -Algorithm SHA256
Get-FileHash .\Flare-Setup-<version>.exe -Algorithm SHA512
```

- `Status` must be `Valid` and the signer must be **SignPath Foundation**.
- The SHA-256 must match the value published with the corresponding GitHub
  Release (and on the product download page).
- The base64 SHA-512 must match `sha512` in the published `<channel>.yml`.

## Privacy

The client is read-only and does not send user-authored text to any LLM. Data
handling is described in [`PRIVACY.md`](../PRIVACY.md). Security reports go to
`support@flyflare.ru` (see [`SECURITY.md`](../SECURITY.md)).

## Compromise and revocation

If a signing credential, build runner or release artifact is suspected to be
compromised:

1. Signing requests are suspended and the SignPath signing policy is disabled.
2. The affected GitHub Release is marked as withdrawn; the update feed is not
   pointed at it.
3. A security advisory is published and `support@flyflare.ru` is used to inform
   users.
4. A fixed release is built from a clean commit and signed again.

## Changes to this policy

Changes are made by a pull request to this repository and reviewed by the
repository owner. The effective date at the top is updated.
