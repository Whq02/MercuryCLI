// Ambient JSX intrinsic declarations for the source-built Ink host elements
// (ink-box / ink-text / ink-link / ink-raw-ansi). Ink's own JSX typings were
// stripped in the source build; these are internal render primitives the ink
// reconciler (reconciler.ts / dom.ts) handles at runtime, NOT a public API, so
// the props are intentionally permissive (a string index admits ref / style /
// the DOM event handlers the components forward). Type-only — emits nothing.
//
// React 19 (@types/react 19) declares JSX as `React.JSX` (the `react` module
// namespace), so the intrinsics are augmented there, not the legacy global JSX.
import type { ReactNode } from 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': { children?: ReactNode } & Record<string, unknown>
      'ink-text': { children?: ReactNode } & Record<string, unknown>
      'ink-link': { children?: ReactNode } & Record<string, unknown>
      'ink-raw-ansi': Record<string, unknown>
    }
  }
}
