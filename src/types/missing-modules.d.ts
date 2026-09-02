// Ambient declarations for modules that are absent from the source tree but
// resolved (or eliminated) by the BUILD, not by tsc. Type-only — a .d.ts is
// never bundled and is invisible to the bundler, so these have ZERO runtime or
// build impact. They exist purely so the strict typecheck floor stops reporting
// TS2307 for imports the build already handles.
//
// Two kinds live here:
//   1. statically-imported optional deps that carry named value/type imports
//      (color-diff-napi — resolved by build.ts STUB_MAP — and vscode-jsonrpc's
//      node entry). A bare `export =` body would fail named *type* imports
//      (TS2305/TS2694), so these enumerate their imported names explicitly
//      (value → const, type → type).
//   2. optional runtime deps loaded via dynamic `import()` / `require()` inside
//      try-catch (napi addons, cli-highlight, plist, cacache, bun:ffi) — external
//      to the bundle, present only if installed at runtime. They are accessed via
//      `typeof import()` / destructured `await import()`, so `export = any`
//      satisfies every member access at once.

// ── statically-imported optional native deps (carry named type imports) ──

declare module 'color-diff-napi' {
  export type SyntaxTheme = any;
  export const ColorDiff: any;
  export const ColorFile: any;
  export const getSyntaxTheme: any;
}

declare module 'vscode-jsonrpc/node.js' {
  export type MessageConnection = any;
  export const createMessageConnection: any;
  export const StreamMessageReader: any;
  export const StreamMessageWriter: any;
  export const Trace: any;
}

declare module 'src/tasks/MonitorMcpTask/MonitorMcpTask.js' {
  export type MonitorMcpTaskState = any;
}

// ── purely dynamic optional deps (import()/require()/typeof import) ──
// `export = any` satisfies destructured `await import()` and `typeof import().x`.

declare module 'image-processor-napi' { const m: any; export = m; }
declare module 'url-handler-napi' { const m: any; export = m; }
// accessed as `typeof import('cli-highlight').highlight` (named member on the
// typeof-import type), so it needs an ES-shape with those members, not `export =`.
declare module 'cli-highlight' {
  export const highlight: any;
  export const supportsLanguage: any;
}
declare module 'plist' { const m: any; export = m; }
declare module 'cacache' { const m: any; export = m; }
declare module 'bun:ffi' { const m: any; export = m; }
