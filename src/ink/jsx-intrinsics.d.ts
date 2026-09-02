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
