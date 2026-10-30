import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Stable per-machine identifier (ADR-0018 §5, CD-6.2).
 *
 * A random 128-bit value kept in its **own** file — never inside the device
 * tokens (`tokens.enc`) or `auth.json`. The raw value is only ever passed to
 * the agent-host via the `FLIGHTLOG_MACHINE_ID` env var and is **never logged**.
 * The server stores only `sha256(machine_id)` (`devices.machine_hash`).
 */

/** Random 128 bits. */
export const MACHINE_ID_BYTES = 16;

/** Same shape the server/contracts accept (`^[A-Za-z0-9._~-]{16,128}$`). */
export const MACHINE_ID_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;

/** `base64url` of 16 random bytes → 22 url-safe chars. */
export function generateMachineId(): string {
  return randomBytes(MACHINE_ID_BYTES).toString('base64url');
}

export function isValidMachineId(value: string): boolean {
  return MACHINE_ID_PATTERN.test(value);
}

/** Separate file next to (not inside) the agent data dir. */
export function machineIdPath(dataDir: string): string {
  return join(dataDir, 'machine-id');
}

export interface MachineIdStoreOptions {
  /** Diagnostics sink — must never receive the raw id. */
  onWarn?(message: string): void;
}

/**
 * Reads the machine id once, or creates it atomically on first run. Idempotent:
 * concurrent/repeated calls share the cached value for the process lifetime.
 */
export class MachineIdStore {
  private cached: string | null = null;

  constructor(
    private readonly filePath: string,
    private readonly options: MachineIdStoreOptions = {},
  ) {}

  get path(): string {
    return this.filePath;
  }

  async getOrCreate(): Promise<string> {
    if (this.cached) return this.cached;

    const existing = await this.read();
    if (existing) {
      this.cached = existing;
      return existing;
    }

    const generated = generateMachineId();
    await this.persist(generated);
    this.cached = generated;
    return generated;
  }

  private async read(): Promise<string | null> {
    let raw: Buffer;
    try {
      raw = await readFile(this.filePath);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      this.warn('machine-id: unreadable file; issuing a new id');
      return null;
    }
    if (raw.length === 0) return null;
    const value = raw.toString('utf8').trim();
    if (!isValidMachineId(value)) {
      this.warn('machine-id: invalid file content; issuing a new id');
      return null;
    }
    return value;
  }

  private async persist(value: string): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, `${value}\n`, { mode: 0o600 });
      await rename(tempPath, this.filePath);
    } catch (error) {
      // Best-effort: keep the in-memory id so the current session still works.
      // Never include the raw id in diagnostics.
      await rm(`${this.filePath}.tmp`, { force: true }).catch(() => undefined);
      this.warn(
        `machine-id: could not persist (${error instanceof Error ? error.name : 'error'}); using a session id`,
      );
    }
  }

  private warn(message: string): void {
    this.options.onWarn?.(message);
  }
}
