import { Buffer } from 'node:buffer';
import { join, resolve, sep } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  XPLANE_ACF_MAX_BYTES,
  XPLANE_LOG_TAIL_MAX_BYTES,
  parseAcfIdentity,
  parseLogAircraftPath,
  resolveXPlaneAircraftIdentity,
  type XPlaneAircraftIdentityOptions,
} from './aircraft-identity.js';

interface VirtualFile {
  text: string;
  mtimeMs?: number;
  size?: number;
  isFile?: boolean;
}

interface VirtualEntry {
  text: string;
  mtimeMs: number;
  size: number;
  isFile: boolean;
}

function createVirtualInstall(files: Record<string, VirtualFile>) {
  const entries = new Map<string, VirtualEntry>();
  for (const [path, file] of Object.entries(files)) {
    entries.set(resolve(path), {
      text: file.text,
      mtimeMs: file.mtimeMs ?? 1,
      size: file.size ?? Buffer.byteLength(file.text),
      isFile: file.isFile ?? true,
    });
  }

  const exists = (path: string): boolean => {
    const key = resolve(path);
    if (entries.has(key)) return true;
    return [...entries.keys()].some((entry) => entry.startsWith(key + sep));
  };
  const stat = (path: string) => {
    const entry = entries.get(resolve(path));
    return entry ? { mtimeMs: entry.mtimeMs, size: entry.size, isFile: entry.isFile } : null;
  };
  const readFile = (path: string): string => {
    const entry = entries.get(resolve(path));
    if (!entry) throw new Error(`ENOENT: ${path}`);
    return entry.text;
  };
  const readTail = (path: string, maxBytes: number): string | null => {
    const entry = entries.get(resolve(path));
    return entry ? entry.text.slice(-maxBytes) : null;
  };
  const realpath = (path: string): string => resolve(path);

  return {
    exists,
    stat,
    readFile,
    readTail,
    realpath,
    setText(path: string, text: string): void {
      const entry = entries.get(resolve(path));
      if (entry) entry.text = text;
    },
    setMtime(path: string, mtimeMs: number): void {
      const entry = entries.get(resolve(path));
      if (entry) entry.mtimeMs = mtimeMs;
    },
  };
}

const ROOT = resolve('virtual-xplane');
const LOG_PATH = join(ROOT, 'Log.txt');
const ACF_PATH = join(ROOT, 'Aircraft', 'Laminar Research', 'Airbus A320', 'A320.acf');
const ACF_RELATIVE = 'Aircraft/Laminar Research/Airbus A320/A320.acf';

function logLine(path = ACF_RELATIVE): string {
  return `0:00:01.000 I/ACF: Loading airplane number 0 with ${path}`;
}

// Real X-Plane 11/12 text `.acf` shape: `P <key> <value>` inside PROPERTIES.
const REAL_ACF = [
  'I',
  '1200 Version',
  'ACF',
  '',
  'PROPERTIES_BEGIN',
  'P acf/_name Airbus A320neo',
  'P acf/_ICAO A20N',
  'P acf/_descrip Airbus A320neo',
  'P acf/_tailnum D-AINA',
  'P _engn/0/_type JET',
  'P _obja/0/_v10_att_file_stl A320.obj',
  'PROPERTIES_END',
].join('\n');

const BARE_ACF = 'acf/_ICAO A21N\nacf/_descrip Airbus A321neo\n';

function resolverOptions(
  fs: ReturnType<typeof createVirtualInstall>,
  overrides: Partial<XPlaneAircraftIdentityOptions> = {},
) {
  return {
    env: { FLIGHTLOG_XPLANE_DIR: ROOT },
    enableDefaults: false,
    exists: fs.exists,
    stat: fs.stat,
    readFile: fs.readFile,
    readTail: fs.readTail,
    realpath: fs.realpath,
    cache: new Map(),
    ...overrides,
  };
}

describe('parseLogAircraftPath', () => {
  it('находит последнюю загрузку: CRLF/LF, пробелы, оба разделителя', () => {
    const text = [
      '0:00:00.000 I/ACF: Loading airplane number 0 with Aircraft/First/One.acf',
      'noise',
      '0:00:01.000 I/ACF: Loading airplane number 0 with Aircraft\\Laminar Research\\Airbus A320\\A320.acf',
      '0:00:02.000 I/ACF: Loading airplane number 1 with Aircraft/Other.acf',
    ].join('\r\n');

    expect(parseLogAircraftPath(text)).toBe('Aircraft\\Laminar Research\\Airbus A320\\A320.acf');
    expect(parseLogAircraftPath(text.replace(/\r\n/g, '\n'))).toBe(
      'Aircraft\\Laminar Research\\Airbus A320\\A320.acf',
    );
  });

  it('нет загрузки/битая строка → null', () => {
    expect(parseLogAircraftPath('')).toBeNull();
    expect(parseLogAircraftPath('nothing here')).toBeNull();
    expect(parseLogAircraftPath('Loading airplane number 0 with')).toBeNull();
    expect(parseLogAircraftPath('Loading airplane number 0 with .acf')).toBeNull();
    expect(parseLogAircraftPath('Loading airplane number 0 with Aircraft/foo.txt')).toBeNull();
    expect(
      parseLogAircraftPath('Loading airplane number 0 with Aircraft/foo.acf trailing'),
    ).toBeNull();
  });

  it('отклоняет traversal-путь с `..`', () => {
    expect(
      parseLogAircraftPath('Loading airplane number 0 with Aircraft/../../evil.acf'),
    ).toBeNull();
    expect(parseLogAircraftPath('Loading airplane number 0 with ..\\evil.acf')).toBeNull();
  });
});

describe('parseAcfIdentity', () => {
  it('реальный формат: `P acf/_ICAO` внутри PROPERTIES_BEGIN..END', () => {
    expect(parseAcfIdentity(REAL_ACF)).toEqual({ icao: 'A20N', title: 'Airbus A320neo' });
  });

  it('сохраняет поддержку голых строк `acf/_ICAO`', () => {
    expect(parseAcfIdentity(BARE_ACF)).toEqual({ icao: 'A21N', title: 'Airbus A321neo' });
  });

  it('CRLF, пробелы, кавычки и регистр префикса P нормализуются', () => {
    const text = 'p  acf/_ICAO   "a20n"\r\nP\tacf/_descrip  "Airbus A320neo"\r\n';
    expect(parseAcfIdentity(text)).toEqual({ icao: 'A20N', title: 'Airbus A320neo' });
  });

  it('title fallback: нет/пустой descrip → ICAO', () => {
    expect(parseAcfIdentity('P acf/_ICAO A20N\n')).toEqual({ icao: 'A20N', title: 'A20N' });
    expect(parseAcfIdentity('P acf/_ICAO A20N\nP acf/_descrip   \n')).toEqual({
      icao: 'A20N',
      title: 'A20N',
    });
    expect(parseAcfIdentity('acf/_ICAO A20N\nacf/_descrip   \n')).toEqual({
      icao: 'A20N',
      title: 'A20N',
    });
  });

  it('берёт первое непустое значение ключа', () => {
    expect(parseAcfIdentity('P acf/_ICAO\nP acf/_ICAO A20N\n')).toEqual({
      icao: 'A20N',
      title: 'A20N',
    });
    expect(parseAcfIdentity('P acf/_ICAO A20N\nP acf/_ICAO B738\n')).toEqual({
      icao: 'A20N',
      title: 'A20N',
    });
  });

  it('нет/пустой/malformed ICAO → null', () => {
    expect(parseAcfIdentity('')).toBeNull();
    expect(parseAcfIdentity('acf/_descrip Airbus A320neo')).toBeNull();
    expect(parseAcfIdentity('acf/_ICAO\nacf/_descrip Airbus A320neo')).toBeNull();
    expect(parseAcfIdentity('P acf/_ICAO\nP acf/_descrip Airbus A320neo')).toBeNull();
    expect(parseAcfIdentity('P\nPROPERTIES_BEGIN\nPROPERTIES_END\n')).toBeNull();
    expect(parseAcfIdentity('P acf/_ICAO ???\n')).toBeNull();
    expect(parseAcfIdentity('P acf/_ICAO A\n')).toBeNull();
    expect(parseAcfIdentity('P acf/_ICAO TOOLONG\n')).toBeNull();
  });

  it('ZZZZ отвергается (в т.ч. через canonicalization)', () => {
    expect(parseAcfIdentity('P acf/_ICAO ZZZZ\nP acf/_descrip Unknown\n')).toBeNull();
    expect(parseAcfIdentity('acf/_ICAO ZZZZ\nacf/_descrip Unknown\n')).toBeNull();
  });

  it('descrip: bidi/zero-width вычищены, длина ≤120', () => {
    const descrip = `A320\u202E\u200B\u2028${'x'.repeat(200)}`;
    const identity = parseAcfIdentity(`P acf/_ICAO A20N\nP acf/_descrip ${descrip}\n`);

    expect(identity?.icao).toBe('A20N');
    expect(identity?.title.length).toBeLessThanOrEqual(120);
    expect(identity?.title).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(identity?.title.startsWith('A320')).toBe(true);
  });
});

describe('resolveXPlaneAircraftIdentity', () => {
  it('нет install dir / нет Log.txt / нечитаемый ACF → null, без throw', () => {
    expect(
      resolveXPlaneAircraftIdentity({
        env: {},
        enableDefaults: false,
        exists: () => false,
        cache: new Map(),
      }),
    ).toBeNull();

    const noLog = createVirtualInstall({ [join(ROOT, 'X-Plane.exe')]: { text: '' } });
    expect(resolveXPlaneAircraftIdentity(resolverOptions(noLog))).toBeNull();

    const unreadable = createVirtualInstall({
      [join(ROOT, 'X-Plane.exe')]: { text: '' },
      [LOG_PATH]: { text: logLine() },
      [ACF_PATH]: { text: REAL_ACF },
    });
    expect(
      resolveXPlaneAircraftIdentity(
        resolverOptions(unreadable, {
          readFile: () => {
            throw new Error('EACCES');
          },
        }),
      ),
    ).toBeNull();

    const unreadableLog = createVirtualInstall({
      [join(ROOT, 'X-Plane.exe')]: { text: '' },
      [LOG_PATH]: { text: logLine() },
      [ACF_PATH]: { text: REAL_ACF },
    });
    expect(
      resolveXPlaneAircraftIdentity(
        resolverOptions(unreadableLog, {
          readTail: () => null,
        }),
      ),
    ).toBeNull();
  });

  it('читает последнюю загрузку и .acf через env-дискавери', () => {
    const fs = createVirtualInstall({
      [join(ROOT, 'X-Plane.exe')]: { text: '' },
      [LOG_PATH]: {
        text: [logLine('Aircraft/First/One.acf'), logLine(ACF_RELATIVE)].join('\r\n'),
      },
      [ACF_PATH]: { text: REAL_ACF },
    });

    expect(resolveXPlaneAircraftIdentity(resolverOptions(fs))).toEqual({
      icao: 'A20N',
      title: 'Airbus A320neo',
    });
  });

  it('отклоняет `../` и абсолютный путь вне install root', () => {
    const outside = resolve('outside-root', 'evil.acf');
    const fs = createVirtualInstall({
      [join(ROOT, 'X-Plane.exe')]: { text: '' },
      [LOG_PATH]: { text: logLine('Aircraft/../../evil.acf') },
      [outside]: { text: REAL_ACF },
    });
    expect(resolveXPlaneAircraftIdentity(resolverOptions(fs))).toBeNull();

    const absolute = createVirtualInstall({
      [join(ROOT, 'X-Plane.exe')]: { text: '' },
      [LOG_PATH]: { text: logLine(outside) },
      [outside]: { text: REAL_ACF },
    });
    expect(resolveXPlaneAircraftIdentity(resolverOptions(absolute))).toBeNull();
  });

  it('не-regular файл (FIFO/устройство) → null', () => {
    const acfNotFile = createVirtualInstall({
      [join(ROOT, 'X-Plane.exe')]: { text: '' },
      [LOG_PATH]: { text: logLine() },
      [ACF_PATH]: { text: REAL_ACF, isFile: false },
    });
    expect(resolveXPlaneAircraftIdentity(resolverOptions(acfNotFile))).toBeNull();

    const logNotFile = createVirtualInstall({
      [join(ROOT, 'X-Plane.exe')]: { text: '' },
      [LOG_PATH]: { text: logLine(), isFile: false },
      [ACF_PATH]: { text: REAL_ACF },
    });
    expect(resolveXPlaneAircraftIdentity(resolverOptions(logNotFile))).toBeNull();
  });

  it('слишком большой .acf → null и файл не читается', () => {
    const fs = createVirtualInstall({
      [join(ROOT, 'X-Plane.exe')]: { text: '' },
      [LOG_PATH]: { text: logLine() },
      [ACF_PATH]: { text: REAL_ACF, size: XPLANE_ACF_MAX_BYTES + 1 },
    });
    const readFile = vi.fn(fs.readFile);

    expect(resolveXPlaneAircraftIdentity(resolverOptions(fs, { readFile }))).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('большой Log.txt читается только хвостом 256 KiB', () => {
    const fs = createVirtualInstall({
      [join(ROOT, 'X-Plane.exe')]: { text: '' },
      [LOG_PATH]: {
        text: `${'x'.repeat(XPLANE_LOG_TAIL_MAX_BYTES + 100)}\r\n${logLine()}\r\n`,
      },
      [ACF_PATH]: { text: REAL_ACF },
    });
    const readTail = vi.fn(fs.readTail);

    expect(resolveXPlaneAircraftIdentity(resolverOptions(fs, { readTail }))).toEqual({
      icao: 'A20N',
      title: 'Airbus A320neo',
    });
    expect(readTail).toHaveBeenCalledWith(LOG_PATH, XPLANE_LOG_TAIL_MAX_BYTES);
  });

  it('кэш по mtime: без изменений не перечитывает, после смены — обновляет', () => {
    const fs = createVirtualInstall({
      [join(ROOT, 'X-Plane.exe')]: { text: '' },
      [LOG_PATH]: { text: logLine(), mtimeMs: 10 },
      [ACF_PATH]: { text: REAL_ACF, mtimeMs: 20 },
    });
    const cache = new Map();
    const readFile = vi.fn(fs.readFile);
    const options = resolverOptions(fs, { cache, readFile });

    expect(resolveXPlaneAircraftIdentity(options)).toEqual({
      icao: 'A20N',
      title: 'Airbus A320neo',
    });
    expect(readFile).toHaveBeenCalledTimes(1);

    expect(resolveXPlaneAircraftIdentity(options)).toEqual({
      icao: 'A20N',
      title: 'Airbus A320neo',
    });
    expect(readFile).toHaveBeenCalledTimes(1);

    fs.setText(
      ACF_PATH,
      REAL_ACF.replace('P acf/_ICAO A20N', 'P acf/_ICAO A21N').replace(
        'P acf/_descrip Airbus A320neo',
        'P acf/_descrip Airbus A321neo',
      ),
    );
    fs.setMtime(ACF_PATH, 21);
    expect(resolveXPlaneAircraftIdentity(options)).toEqual({
      icao: 'A21N',
      title: 'Airbus A321neo',
    });
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('смена Log.txt подхватывает другой борт', () => {
    const secondAcf = join(ROOT, 'Aircraft', 'Boeing 737', 'B738.acf');
    const fs = createVirtualInstall({
      [join(ROOT, 'X-Plane.exe')]: { text: '' },
      [LOG_PATH]: { text: logLine(), mtimeMs: 10 },
      [ACF_PATH]: { text: REAL_ACF, mtimeMs: 20 },
      [secondAcf]: {
        text: 'acf/_ICAO B738\nacf/_descrip Boeing 737-800\n',
        mtimeMs: 30,
      },
    });
    const cache = new Map();
    const options = resolverOptions(fs, { cache });

    expect(resolveXPlaneAircraftIdentity(options)?.icao).toBe('A20N');

    fs.setText(LOG_PATH, logLine('Aircraft/Boeing 737/B738.acf'));
    fs.setMtime(LOG_PATH, 11);
    expect(resolveXPlaneAircraftIdentity(options)).toEqual({
      icao: 'B738',
      title: 'Boeing 737-800',
    });
  });
});
