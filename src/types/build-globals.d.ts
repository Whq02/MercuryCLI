// Ambient declarations for globals that exist at RUNTIME but have no typed
// package backing them in the source tree. These are type-only and emit nothing
// — they exist purely so the strict typecheck floor (`tsconfig.json`, strict)
// can resolve names the build injects or the Bun runtime provides. They have
// ZERO effect on the bundled artifact.

// `MACRO` is the build-time constants object injected by `build.ts` via esbuild
// `define` (`MACRO: JSON.stringify(MACRO)`), so every `MACRO.*` reference folds
// to a string literal at bundle time. Shape mirrors the object literal in
// build.ts exactly — all seven fields are strings. Keep in sync with build.ts
// if a field is added (de-stale on contact).
declare const MACRO: {
  readonly VERSION: string;
  readonly PACKAGE_URL: string;
  readonly NATIVE_PACKAGE_URL: string;
  readonly FEEDBACK_CHANNEL: string;
  readonly BUILD_TIME: string;
  readonly VERSION_CHANGELOG: string;
  readonly ISSUES_EXPLAINER: string;
};

// `Bun` is the Bun runtime global (Bun.hash / Bun.spawn / Bun.semver / etc., and
// `typeof Bun !== 'undefined'` capability guards). We deliberately do NOT vendor
// `bun-types`/`@types/bun`: that package redefines a large surface of overlapping
// globals (fetch/Request/WebSocket/Worker) and would shift many unrelated
// fingerprints. `any` is the honest type here — this is an untyped external
// runtime global, not API we own or can verify.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Bun: any;
