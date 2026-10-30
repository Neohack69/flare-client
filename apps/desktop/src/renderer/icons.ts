import type { AgentStatusIcon } from '@flightlog/contracts';

/**
 * Inline SVG-глифы локальных страниц (lucide-имена из `agentStatusMap`).
 * Только статические строки — CSP `script-src 'self'`, без CDN/шрифтов.
 */

export type UiIcon =
  | AgentStatusIcon
  | 'monitor'
  | 'external'
  | 'stop'
  | 'play'
  | 'folder'
  | 'copy'
  | 'check'
  | 'info'
  | 'refresh'
  | 'warning'
  | 'minimize'
  | 'close'
  | 'clock'
  | 'brand';

const S =
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

function wrap(inner: string, size = 18): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" ${S}>${inner}</svg>`;
}

const GLYPHS: Record<UiIcon, string> = {
  'log-in':
    '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>',
  radar:
    '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  'circle-dot':
    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  'plane-landing':
    '<path d="M2 22h20"/><path d="M3 15.5 5.5 17l3-1 1.5 2 3.5-1.4L22 19l-1.5 3H6.2L2 17.5Z"/><path d="M2.2 9.3 4 13l4-1.6L13.5 15 21 12.4l-1.2-3.1-6 1.5-3.2-4.1-2 .8 1.2 3.8Z"/>',
  'refresh-cw':
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
  'cloud-check':
    '<path d="M12 22H6a4 4 0 0 1 0-8h.5A6 6 0 0 1 18 9a5 5 0 0 1 1 9.9"/><path d="m9 15 2 2 4-4"/>',
  'cloud-off':
    '<path d="m2 2 20 20"/><path d="M5.78 5.78A7 7 0 0 0 4 10.5 4 4 0 0 0 6 19h11"/><path d="M17.5 17.5H19a4 4 0 0 0 .5-8 6 6 0 0 0-2.16-3.94"/>',
  'triangle-alert':
    '<path d="m10.29 3.86-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3l-8-14a2 2 0 0 0-3.44 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'octagon-alert':
    '<path d="M12 16h.01"/><path d="M12 8v4"/><path d="M15.31 2a2 2 0 0 1 1.41.59l4.69 4.69A2 2 0 0 1 22 8.69v6.62a2 2 0 0 1-.59 1.41l-4.69 4.69a2 2 0 0 1-1.41.59H8.69a2 2 0 0 1-1.41-.59l-4.69-4.69A2 2 0 0 1 2 15.31V8.69a2 2 0 0 1 .59-1.41l4.69-4.69A2 2 0 0 1 8.69 2Z"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><path d="M12 2v10"/>',
  monitor:
    '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  external:
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  stop: '<rect width="16" height="16" x="4" y="4" rx="2"/>',
  play: '<path d="M6 3 20 12 6 21Z"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  copy: '<rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  refresh:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
  warning:
    '<path d="m10.29 3.86-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3l-8-14a2 2 0 0 0-3.44 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  minimize: '<path d="M5 12h14"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  brand:
    '<path d="M2.6 16.4H21.4" stroke-width="1.6"/><path d="M10.13 16.4A6 6 0 1 1 13.87 16.4" stroke-width="1.6"/><path d="M10.13 16.4H13.87" stroke-width="2.4"/>',
};

export function iconSvg(name: UiIcon, size = 18): string {
  return wrap(GLYPHS[name] ?? GLYPHS.info, size);
}
