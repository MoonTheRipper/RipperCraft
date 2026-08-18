// Pixel-art icon set, chosen so the dashboard reads as a Minecraft tool rather
// than a generic admin panel: blocky 24x24 glyphs on an integer grid, drawn with
// square edges (see `shape-rendering` in styles.css) so they stay crisp instead
// of smoothing into the rounded look of a typical UI kit.
//
// Source: Pixelarticons v2.4.1 by Gerrit Halfmann, MIT licensed.
// https://github.com/halfmage/pixelarticons - see THIRD-PARTY-NOTICES.md.
// Paths are inlined rather than pulled from a CDN so the dashboard keeps
// working with no network and ships no third-party runtime dependency.
export const ICONS = {
  admin: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 2h6v2H5zm10 0h4v2h-4zM5 10h6v2H5zm10 0h4v2h-4zm4-6h2v6h-2zm-8 0h2v6h-2zM3 4h2v6H3zM0 18h2v4H0zm14 0h2v4h-2zm8 0h2v4h-2zM4 14h8v2H4zm12 0h4v2h-4zM2 16h2v2H2zm10 0h2v2h-2zm8 0h2v2h-2z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 18H8v-2h2v2Zm-2-2H6v-2h2v2Zm4-2v2h-2v-2h2Zm-6 0H4v-2h2v2Zm8 0h-2v-2h2v2Zm2-2h-2v-2h2v2Zm2-2h-2V8h2v2Zm2-2h-2V6h2v2Z"/></svg>',
  client: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 2h16v2H4zm0 14h16v2H4zM2 4h2v12H2zm18 0h2v12h-2zm-9 14h2v2h-2zm-3 2h8v2H8z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 2h12v2H6zM2 6h2v12H2zm18 0h2v12h-2zm-2-2h2v2h-2zM4 4h2v2H4zm2 18h12v-2H6zm12-2h2v-2h-2zM4 20h2v-2H4zm7-14h2v7h-2zm2 7h2v2h-2zm2 2h2v2h-2z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 15v4h-2v-4zm-2 4v2H5v-2zM5 15v4H3v-4zm8-12v14h-2V3z"/><path d="M7 11v2h10v-2zm2 2v2h2v-2zm4 0v2h2v-2z"/><path d="M15 11v2h2v-2z"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-4 8h2v2h-2zm-2 2h2v2h-2zm4 0h2v2h-2zm-8 0h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2z"/><path d="M20 16h2v2h-2zM8 16h2v2H8zm-2 2h2v2H6zM8 6h2v2H8zM6 8h2v2H6zm2 2h2v2H8zm2-2h2v2h-2z"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11 5H5v2h6V5ZM5 7H3v12h2V7Zm12 12H5v2h12v-2Zm2-6h-2v6h2v-6Zm-8 0H9v2h2v-2Zm2-2h-2v2h2v-2Zm2-2h-2v2h2V9Zm2-2h-2v2h2V7Zm2-2h-2v2h2V5Zm2-2h-2v8h2V3Z"/><path d="M21 3h-8v2h8V3Z"/></svg>',
  logs: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4H4v16h2zm10-2H6v2h10zm4 4h-2v14h2zm-2 14H6v2h12zM16 4h2v2h-2zm-4 0h2v6h-2z"/><path d="M12 8h6v2h-6zm-4 8h8v2H8zm0-4h8v2H8zm0-4h2v2H8z"/></svg>',
  mods: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15 1h6v2h-6zm-2 2h2v6h-2zm2 6h6v2h-6zm6-6h2v6h-2zM3 5h6v2H3zM1 7h2v14H1zm2 14h14v2H3zm14-6h2v6h-2zM3 13h14v2H3z"/><path d="M9 7h2v14H9z"/></svg>',
  overview: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 20H4v-2h4v-8H4v8H2V6h2v2h16V6h2v12h-2v-8H10v8h10v2Zm0-14H4V4h16v2Z"/></svg>',
  owner: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 3h2v12H3zm16 0h2v12h-2zm-8 0h2v2h-2zM9 5h2v2H9zM5 5h2v2H5z"/><path d="M3 3h2v2H3zm4 4h2v2H7zm6-2h2v2h-2zm2 2h2v2h-2zm2-2h2v2h-2zM5 15h14v2H5zm-2 4h18v2H3z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 4h2v6h-2zm-2-2h2v2h-2zm0 2h2v8h-2zM4 8H2v5h2z"/><path d="M4 6h16v2H4zm4 14H6v-6h2zm2 2H8v-2h2zm0-2H8v-8h2zm10-4h2v-5h-2z"/><path d="M20 18H4v-2h16z"/></svg>',
  runtime: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 20h12v2H6zM18 6h2v2h-2zM4 6h2v2H4zm2-2h2v2H6zm10 0h2v2h-2zM4 18h2v2H4zm14 0h2v2h-2zM2 8h2v10H2zm18 0h2v10h-2zm-9-6h2v9h-2z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22 22h-2v-2h2v2Zm-2-2h-2v-2h2v2Zm-6-2H6v-2h8v2Zm4 0h-2v-2h2v2ZM6 16H4v-2h2v2Zm10 0h-2v-2h2v2ZM4 14H2V6h2v8Zm14 0h-2V6h2v8ZM6 6H4V4h2v2Zm10 0h-2V4h2v2Zm-2-2H6V2h8v2Z"/></svg>',
  server: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 7h4v2H6zm0 8h4v2H6zM2 5h2v14H2zm18 0h2v14h-2zM4 19h16v2H4zM4 3h16v2H4zm0 8h16v2H4z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 14H7v6H5v-6H2v-2h6v2Zm5 6h-2V10h2v10Zm9-2h-3v2h-2v-2h-1v-2h6v2Zm-3-4h-2V4h2v10ZM7 10H5V4h2v6Zm6-4h2v2H9V6h2V4h2v2Z"/></svg>',
  start: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15 11h-2V9h2zm0 4h-2v-2h2zm-2 2h-2v-2h2zm0-8h-2V7h2zm-2-2H9V5h2zM9 21H7V3h2zm6-8h2v-2h-2zm-6 4h2v2H9z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 20H4V4H20V20ZM6 18H18V6H6V18ZM14 14H10V10H14V14Z"/></svg>',
  sword: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11 2h2v2h-2zM9 4h2v12H9zm4 0h2v12h-2zM7 16h10v2H7zm4 2h2v4h-2z"/></svg>',
  theme: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18 22H8v-2h10v2ZM8 20H6v-2h2v2Zm12 0h-2v-2h2v2ZM6 18H4v-2h2v2Zm16 0h-2v-4h-2v-2h2v-2h2v8ZM4 16H2V6h2v10Zm14 0h-6v-2h6v2Zm-6-2h-2v-2h2v2Zm-2-2H8V6h2v6ZM6 6H4V4h2v2Zm8-2h-2v2h-2V4H6V2h8v2Z"/></svg>',
  tools: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 22H7v-2h2v2Zm12-6h2v6h-6v-6h2v-6h2v6Zm-2 2v2h2v-2h-2ZM7 20H5v-8h2v8Zm4 0H9v-8h2v8Zm-6-8H3v-2h2v2Zm8 0h-2v-2h2v2ZM3 10H1V4h2v6Zm12 0h-2V4h2v6Zm4 0h-2V4h2v6Zm4 0h-2V4h2v6ZM7 6h2V2h4v2h-2v4H5V4H3V2h4v4Zm14-2h-2V2h2v2Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18 22H6V20H18V22ZM9 6H15V4H17V6H22V8H20V20H18V8H6V20H4V8H2V6H7V4H9V6ZM15 4H9V2H15V4Z"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 8h14v2H5zm0 12h14v2H5zM3 10h2v10H3zm16 0h2v10h-2zM7 4h2v4H7zm2-2h6v2H9zm6 2h2v2h-2z"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 21H5v-2h14v2ZM5 19H3v-4h2v4Zm16 0h-2v-4h2v4ZM13 5h2v2h2v2h-4v8h-2V9H7V7h2V5h2V3h2v2Z"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 2h16v2H4zm0 18h16v2H4zM20 4h2v16h-2zM2 4h2v16H2zm9 2h2v8h-2zm0 10h2v2h-2z"/></svg>',
  worlds: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 2h12v2H6zm0 18h12v2H6zM4 4h2v2H4zm5 0h2v2H9zm0 14h2v2H9zm4 0h2v2h-2zM7 6h2v12H7zm8 0h2v12h-2zm-2-2h2v2h-2zm7 0h-2v2h2zM2 6h2v12H2zm20 0h-2v12h2zM4 18h2v2H4zm16 0h-2v2h2z"/><path d="M3 11h18v2H3z"/></svg>'
};
