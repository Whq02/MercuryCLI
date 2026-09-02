// Ambient declarations for untyped third-party deps (no @types on DefinitelyTyped,
// or not installed here). BUILD-INERT: bun's bundle probe ignores `.d.ts`, so this
// file emits nothing into dist — it only satisfies the strict typecheck, clearing
// TS7016 ("implicitly has an 'any' type" on a module with no declaration file).
//
// The two value-import deps below use shorthand ambient form (whole module → any).
// `proper-lockfile` needs an explicit body because it is consumed via named TYPE
// imports + `typeof import('proper-lockfile')` (a bare shorthand would surface
// TS2709/TS2694 on those — see the typecheck-floor program notes).

declare module 'bidi-js'
declare module 'picomatch'

declare module 'proper-lockfile' {
  export type CheckOptions = any
  export type LockOptions = any
  export type UnlockOptions = any
  export const lock: any
  export const lockSync: any
  export const unlock: any
  export const unlockSync: any
  export const check: any
  export const checkSync: any
}
