import { describe, expect, it } from 'vitest';

import {
  pluginChannelSchema,
  pluginReleaseManifestSchema,
  pluginReleaseResponseSchema,
  pluginReleaseSchema,
} from './plugin';

const SHA256 = 'a'.repeat(64);

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: 'community',
    version: '0.3.0',
    url: 'https://tdmoment.ru/download/plugin/TouchdownMoment-MSFS-0.3.0.zip',
    notes: 'Исправлен разрыв на рулении',
    notes_url: 'https://tdmoment.ru/plugin/changelog',
    sha256: SHA256,
    published_at: '2026-10-01T10:00:00Z',
    mandatory: false,
    min_supported_version: '0.1.0',
    ...overrides,
  };
}

describe('contracts — plugin release feed (api.md §3.7)', () => {
  it('pluginChannelSchema — community|beta', () => {
    expect(pluginChannelSchema.options).toEqual(['community', 'beta']);
    expect(pluginChannelSchema.safeParse('community').success).toBe(true);
    expect(pluginChannelSchema.safeParse('nightly').success).toBe(false);
  });

  it('pluginReleaseSchema принимает валидный релиз', () => {
    const parsed = pluginReleaseSchema.safeParse(release());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.version).toBe('0.3.0');
      expect(parsed.data.mandatory).toBe(false);
    }
  });

  it('defaults: notes/notes_url/sha256 → null, min_supported_version → 0.0.0', () => {
    const parsed = pluginReleaseSchema.parse({
      channel: 'community',
      version: '0.2.0',
      url: 'https://tdmoment.ru/download/plugin/x.zip',
      published_at: '2026-10-01T10:00:00Z',
    });
    expect(parsed.notes).toBeNull();
    expect(parsed.notes_url).toBeNull();
    expect(parsed.sha256).toBeNull();
    expect(parsed.min_supported_version).toBe('0.0.0');
    expect(parsed.mandatory).toBe(false);
  });

  it('отклоняет битую форму (semver/url/sha256), игнорирует лишние поля', () => {
    expect(pluginReleaseSchema.safeParse(release({ version: 'v1' })).success).toBe(false);
    expect(pluginReleaseSchema.safeParse(release({ url: 'ftp://x/y.zip' })).success).toBe(false);
    expect(pluginReleaseSchema.safeParse(release({ sha256: 'zzz' })).success).toBe(false);

    const withExtra = pluginReleaseSchema.safeParse(release({ extra: 1 }));
    expect(withExtra.success).toBe(true);
    if (withExtra.success) expect(withExtra.data).not.toHaveProperty('extra');
  });

  it('pluginReleaseManifestSchema: валидный непустой манифест (community + beta)', () => {
    const ok = pluginReleaseManifestSchema.safeParse({
      releases: [release(), release({ channel: 'beta', version: '0.4.0' })],
    });
    expect(ok.success).toBe(true);
  });

  it('pluginReleaseManifestSchema: пустой/битый манифест отклоняется', () => {
    expect(pluginReleaseManifestSchema.safeParse({}).success).toBe(false);
    expect(pluginReleaseManifestSchema.safeParse({ releases: [] }).success).toBe(false);
    expect(pluginReleaseManifestSchema.safeParse({ releases: [{ version: '1.0.0' }] }).success).toBe(
      false,
    );
  });

  it('pluginReleaseResponseSchema оборачивает релиз в { data }', () => {
    expect(pluginReleaseResponseSchema.safeParse({ data: release() }).success).toBe(true);
    expect(pluginReleaseResponseSchema.safeParse(release()).success).toBe(false);
  });
});
