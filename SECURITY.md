# Security Policy

## Supported versions

Security fixes are shipped in the latest release of the Flare desktop client.
Older versions may not receive fixes; the in-app updater points to the current
stable release.

## Reporting a vulnerability

Please report security issues privately to **support@flyflare.ru**. Include:

- affected version (`Flare` → About, or the installer filename),
- Windows version and simulator (MSFS 2024 / X-Plane 12),
- a short description and, if possible, reproduction steps,
- any logs with personal data removed.

Do **not** open a public GitHub issue for an unpatched vulnerability and do not
attach private keys, tokens or personal data.

We aim to acknowledge reports within 5 business days. Once a fix is available
we will publish a release and credit the reporter if requested.

## Scope

In scope: the desktop client source in this repository, the NSIS installer and
the update metadata published for it.

Out of scope: the hosted Flare service (`flyflare.ru`, `api.flyflare.ru`), the
MSFS plugin, and third-party dependencies (report those upstream, but feel free
to tell us as well).

## Safe disclosure

Please give us a reasonable window to release a fix before public disclosure.
We will coordinate the disclosure date with you.
